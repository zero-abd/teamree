// The process: one HTTP server that answers /healthz, refuses everything else,
// and upgrades exactly one path to a WebSocket. Admission control happens at the
// upgrade, before a connection object exists, so a relay at its cap spends an
// HTTP response on a refusal rather than a socket on it.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { systemClock, type Clock } from '../core/clock.js'
import { defaultConfig, type RelayConfig } from '../core/config.js'
import type { Logger } from '../core/log.js'
import type { PeerSession } from '../core/peerSession.js'
import { CloseCode } from '../core/protocol.js'
import { createTokenBucket, type TokenBucket } from '../core/rateLimit.js'
import { Rendezvous } from '../core/rendezvous.js'
import { createNodeLogger } from './logging.js'
import { attachWebSocket } from './socket.js'

export type RelayOptions = {
  config?: Partial<RelayConfig>
  clock?: Clock
  log?: Logger
}

export type RelayHealth = {
  status: 'ok'
  uptimeMs: number
  connections: { total: number; greeting: number; waiting: number }
  sessions: number
}

export type Relay = {
  readonly port: number
  readonly config: RelayConfig
  health: () => RelayHealth
  /** Runs one sweep now. Exists so tests can drive deadlines without sleeping. */
  sweep: () => void
  /** Closes every session with a reason, then stops listening. */
  close: () => Promise<void>
}

type AddressRecord = { connections: number; handshakes: TokenBucket; lastSeen: number }

/**
 * The client's address, as far as it can be known. With no trusted proxy in
 * front, that is the socket address, which a client cannot lie about. With
 * proxies in front, it is the nth entry from the right of X-Forwarded-For —
 * counted from the right because the rightmost entries were appended by
 * infrastructure the operator controls, while anything further left is whatever
 * the client chose to send.
 */
export function clientAddress(request: IncomingMessage, trustedProxyHops: number): string {
  const socketAddress = request.socket.remoteAddress ?? 'unknown'
  if (trustedProxyHops <= 0) return socketAddress
  const header = request.headers['x-forwarded-for']
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '')
  const chain = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return chain[chain.length - trustedProxyHops] ?? socketAddress
}

function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function startRelay(options: RelayOptions = {}): Promise<Relay> {
  const config: RelayConfig = { ...defaultConfig, ...options.config }
  const clock = options.clock ?? systemClock
  const log = options.log ?? createNodeLogger()
  const rendezvous = new Rendezvous()
  const connections = new Set<PeerSession>()
  const addresses = new Map<string, AddressRecord>()
  // Per-address bookkeeping is itself an attack surface: a flood from fresh
  // addresses would otherwise grow this map for as long as it lasted.
  const addressTableLimit = Math.max(1024, config.maxConnections * 4)
  const startedAt = clock.now()

  let nextConnectionId = 0
  let sweepTimer: NodeJS.Timeout | null = null
  let shuttingDown = false
  let onDrained: (() => void) | null = null

  const pruneAddresses = (now: number, idleForMs: number): void => {
    for (const [address, record] of addresses) {
      if (record.connections <= 0 && now - record.lastSeen > idleForMs) addresses.delete(address)
    }
  }

  const recordFor = (address: string): AddressRecord => {
    const now = clock.now()
    const existing = addresses.get(address)
    if (existing !== undefined) {
      existing.lastSeen = now
      return existing
    }
    if (addresses.size >= addressTableLimit) pruneAddresses(now, 0)
    const record: AddressRecord = {
      connections: 0,
      handshakes: createTokenBucket(
        config.maxConnectionsPerAddressPerMinute / 60,
        config.maxConnectionsPerAddressPerMinute,
        now
      ),
      lastSeen: now
    }
    addresses.set(address, record)
    return record
  }

  const health = (): RelayHealth => {
    let greeting = 0
    for (const connection of connections) {
      if (connection.currentState === 'greeting') greeting += 1
    }
    const stats = rendezvous.stats()
    return {
      status: 'ok',
      uptimeMs: clock.now() - startedAt,
      connections: { total: connections.size, greeting, waiting: stats.waiting },
      sessions: stats.sessions
    }
  }

  const httpServer: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (request.method === 'GET' && path === '/healthz') {
      if (config.healthToken !== null) {
        const presented = (request.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!tokenMatches(presented, config.healthToken)) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end('{"status":"unauthorized"}')
          return
        }
      }
      // Aggregate counts only. Nothing here says which peers are talking, and
      // there is no per-session detail to ask for.
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(health()))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })

  const wss = new WebSocketServer({
    noServer: true,
    // The frame cap is enforced by the parser, so an oversized frame is refused
    // before its bytes are assembled anywhere.
    maxPayload: config.maxFrameBytes,
    // Everything spliced here is ciphertext, which does not compress; deflate
    // would cost CPU for nothing and add a length side channel on top.
    perMessageDeflate: false
  })

  const onClosed = (connection: PeerSession): void => {
    if (!connections.delete(connection)) return
    const record = addresses.get(connection.origin)
    if (record !== undefined) {
      record.connections -= 1
      record.lastSeen = clock.now()
    }
    if (onDrained !== null && connections.size === 0) {
      const drained = onDrained
      onDrained = null
      drained()
    }
  }

  httpServer.on('upgrade', (request, socket, head) => {
    if (shuttingDown) {
      refuseUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    // A trailing segment is a routing hint for hosts that must pick a home for
    // the connection before the hello arrives — a Durable Object is named that
    // way. This host pairs on the rendezvous itself and has no use for it, so it
    // is accepted and ignored rather than made into a second thing to get right.
    if (path !== config.path && !path.startsWith(`${config.path}/`)) {
      refuseUpgrade(socket, 404, 'Not Found')
      return
    }

    const address = clientAddress(request, config.trustedProxyHops)
    const record = recordFor(address)
    const addressRef = log.ref(address)

    if (connections.size >= config.maxConnections) {
      log.warn('upgrade.refused', { reason: 'server at capacity', addressRef })
      refuseUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    if (record.connections >= config.maxConnectionsPerAddress) {
      log.warn('upgrade.refused', { reason: 'address at capacity', addressRef })
      refuseUpgrade(socket, 429, 'Too Many Requests')
      return
    }
    if (!record.handshakes.take(1, clock.now())) {
      log.warn('upgrade.refused', { reason: 'address opening connections too fast', addressRef })
      refuseUpgrade(socket, 429, 'Too Many Requests')
      return
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      nextConnectionId += 1
      record.connections += 1
      const connection = attachWebSocket(`conn_${nextConnectionId}`, address, ws, {
        config,
        clock,
        log,
        rendezvous,
        onClosed
      })
      connections.add(connection)
      log.info('connection.opened', {
        conn: connection.id,
        addressRef,
        address: config.logClientAddress ? address : undefined
      })
    })
  })

  const sweep = (): void => {
    const now = clock.now()
    for (const peer of rendezvous.expiredWaiters(now, config.pairTimeoutMs)) {
      peer.close(CloseCode.PairTimeout, 'no partner arrived within the pairing budget')
    }
    for (const connection of [...connections]) connection.sweep(now)
    pruneAddresses(now, 60_000)
  }

  // Real time, not the injected clock: how often deadlines are checked is this
  // host's business, while what counts as late is core's. Checking at the
  // shorter of the two shortest deadlines keeps a greeting from outliving its
  // budget by a keepalive interval.
  const sweepIntervalMs = Math.min(config.keepaliveIntervalMs, config.helloTimeoutMs)
  const scheduleSweep = (): void => {
    sweepTimer = setTimeout(() => {
      sweep()
      if (!shuttingDown) scheduleSweep()
    }, sweepIntervalMs)
    // The relay's own timers must never be the reason the process stays up; the
    // listening socket is what keeps it alive, and shutdown closes that.
    sweepTimer.unref()
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(config.port, config.host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  scheduleSweep()

  const bound = httpServer.address()
  const port = typeof bound === 'object' && bound !== null ? bound.port : config.port
  log.info('relay.listening', { host: config.host, port, path: config.path })

  const close = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    if (sweepTimer !== null) {
      clearTimeout(sweepTimer)
      sweepTimer = null
    }

    const httpClosed = new Promise<void>((resolve) => httpServer.once('close', () => resolve()))
    // Stop accepting before draining, so nothing joins the set while it empties.
    httpServer.close()

    // Every peer is told the relay is going away, with the standard code, so a
    // client can tell "come back in a moment" from "you did something wrong".
    // The table is emptied first so that nobody is told their partner left.
    rendezvous.clear()
    for (const connection of [...connections]) connection.close(CloseCode.GoingAway, 'relay shutting down')

    await new Promise<void>((resolve) => {
      if (connections.size === 0) {
        resolve()
        return
      }
      // Real time, not the injected clock: this deadline is about how long a
      // network takes to finish a closing handshake, not about a policy the
      // relay enforces. The condition below is what normally ends the wait.
      const deadline = setTimeout(() => {
        // A peer that will not finish the handshake does not get to hold
        // shutdown open; it has already been told why.
        onDrained = null
        for (const client of wss.clients) client.terminate()
        resolve()
      }, config.shutdownGraceMs)
      onDrained = () => {
        clearTimeout(deadline)
        resolve()
      }
    })

    wss.close()
    httpServer.closeAllConnections()
    await httpClosed
    log.info('relay.stopped', {})
  }

  return { port, config, health, sweep, close }
}
