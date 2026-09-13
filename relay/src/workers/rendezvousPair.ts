// The Durable Object that holds one pairing.
//
// One object per rendezvous is the whole point: the pairing has a single
// consistent home, addressed by a name derived from the rendezvous, and the two
// peers land in it from wherever they are. Nothing about the relay's rules lives
// here — they are all in core, which this file wakes up, hands an event to, and
// writes back down.
//
// It uses the WebSocket Hibernation API, because a pair that sits quiet for
// hours is the normal case rather than the exception. Hibernation means the
// object is evicted from memory between frames and its constructor runs again on
// the next one, so nothing may be kept in a field: every event begins by
// rebuilding the sessions from what is attached to each socket, and ends by
// writing them back. `SessionSnapshot` is what makes that possible, and the test
// for it throws this object away between frames on purpose.

import type { Clock } from '../core/clock.js'
import { configFromEnv, type RelayConfig } from '../core/config.js'
import type { Logger } from '../core/log.js'
import { PeerSession, type PeerSocket, type SessionHost, type SessionSnapshot } from '../core/peerSession.js'
import { CloseCode, PING_FRAME, PONG_FRAME } from '../core/protocol.js'
import { randomHex } from '../core/random.js'
import { Rendezvous } from '../core/rendezvous.js'
import { createWorkersLogger } from './logging.js'

const OPEN = 1

/** The slice of the Durable Object runtime this needs, named so it can be faked. */
export type PairState = {
  acceptWebSocket: (socket: PairSocket, tags?: string[]) => void
  getWebSockets: (tag?: string) => PairSocket[]
  setWebSocketAutoResponse: (pair: unknown) => void
  storage: { getAlarm: () => Promise<number | null>; setAlarm: (at: number) => Promise<void> }
}

export type PairSocket = {
  readyState: number
  send: (data: string | ArrayBuffer | ArrayBufferView) => void
  close: (code?: number, reason?: string) => void
  serializeAttachment: (value: unknown) => void
  deserializeAttachment: () => unknown
}

export type PairEnvironment = Record<string, string | undefined>

export type PairDependencies = {
  clock?: Clock
  log?: Logger
  /** Builds the runtime's ping/pong auto-response object. Absent in tests. */
  autoResponse?: (request: string, response: string) => unknown
}

export class RendezvousPair {
  private readonly state: PairState
  private readonly config: RelayConfig
  private readonly clock: Clock
  private readonly log: Logger
  private readonly autoResponse: ((request: string, response: string) => unknown) | undefined

  constructor(state: PairState, env: PairEnvironment, dependencies: PairDependencies = {}) {
    this.state = state
    this.config = configFromEnv(env)
    this.clock = dependencies.clock ?? { now: () => Date.now() }
    this.log = dependencies.log ?? createWorkersLogger()
    this.autoResponse = dependencies.autoResponse

    // Answered by the runtime without waking this object at all, which is what
    // makes a peer's keepalive free rather than the thing that stops hibernation
    // from ever paying off.
    if (this.autoResponse !== undefined) {
      this.state.setWebSocketAutoResponse(this.autoResponse(PING_FRAME, PONG_FRAME))
    }
  }

  /** Takes over an upgrade the Worker has routed here. */
  accept(socket: PairSocket, origin: string): void {
    this.state.acceptWebSocket(socket)
    const id = `peer_${randomHex(6)}`
    const session = this.build(socket, id, origin, undefined)
    socket.serializeAttachment(session.snapshot())
    this.log.info('connection.opened', { conn: id, addressRef: this.log.ref(origin) })
    void this.armAlarm()
  }

  async onMessage(socket: PairSocket, message: string | ArrayBuffer): Promise<void> {
    const live = this.rehydrate()
    const session = live.sessions.get(socket)
    if (session === undefined) return
    if (typeof message === 'string') session.onText(message)
    else session.onBinary(new Uint8Array(message))
    this.persist(live.sessions)
    await this.armAlarm()
  }

  async onClose(socket: PairSocket, code: number): Promise<void> {
    // The closing socket is passed in explicitly because the runtime may already
    // have dropped it from the attached set by the time this runs, and a partner
    // that is never told its peer left is the worst failure this relay has.
    const live = this.rehydrate(socket)
    const session = live.sessions.get(socket)
    if (session === undefined) return
    session.onSocketClosed(code)
    this.persist(live.sessions)
  }

  async onError(socket: PairSocket, error: unknown): Promise<void> {
    this.log.warn('connection.error', { reason: error instanceof Error ? error.message : String(error) })
    await this.onClose(socket, 1006)
  }

  /** The alarm is this host's sweep: the same deadlines, on a different timer. */
  async onAlarm(): Promise<void> {
    const live = this.rehydrate()
    const now = this.clock.now()
    for (const peer of live.rendezvous.expiredWaiters(now, this.config.pairTimeoutMs)) {
      peer.close(CloseCode.PairTimeout, 'no partner arrived within the pairing budget')
    }
    for (const session of live.sessions.values()) session.sweep(now)
    this.persist(live.sessions)
    await this.armAlarm()
  }

  /**
   * Rebuilds every session from what is attached to its socket, and the pairing
   * table from the sessions. This is the whole of what hibernation costs.
   */
  private rehydrate(alsoInclude?: PairSocket): { sessions: Map<PairSocket, PeerSession>; rendezvous: Rendezvous } {
    const rendezvous = new Rendezvous()
    const sessions = new Map<PairSocket, PeerSession>()
    const byToken = new Map<string, PeerSession[]>()

    const attached = this.state.getWebSockets()
    const all = alsoInclude !== undefined && !attached.includes(alsoInclude) ? [...attached, alsoInclude] : attached

    for (const socket of all) {
      const snapshot = socket.deserializeAttachment() as SessionSnapshot | null
      if (snapshot === null || snapshot === undefined) continue
      const session = this.build(socket, snapshot.id, snapshot.origin, snapshot, rendezvous)
      sessions.set(socket, session)
      if (snapshot.token === null || snapshot.state === 'closed') continue
      const group = byToken.get(snapshot.token) ?? []
      group.push(session)
      byToken.set(snapshot.token, group)
    }

    for (const [token, peers] of byToken) {
      // A displaced peer can still be attached for the moment between being told
      // and its close arriving. Paired sessions are the ones that were real, so
      // they come first and at most two are put back.
      const ordered = [...peers].sort(
        (left, right) => Number(right.snapshot().state === 'paired') - Number(left.snapshot().state === 'paired')
      )
      const keep = ordered.slice(0, 2)
      const lead = keep[0]?.snapshot()
      if (lead === undefined) continue
      rendezvous.restore(token, keep, lead.pairRef ?? '', lead.sessionId, lead.openedAt)
    }

    return { sessions, rendezvous }
  }

  private persist(sessions: Map<PairSocket, PeerSession>): void {
    for (const [socket, session] of sessions) {
      // A socket the runtime has already taken away is not an error worth
      // failing an event over; its state is gone either way.
      try {
        socket.serializeAttachment(session.snapshot())
      } catch {
        continue
      }
    }
  }

  private async armAlarm(): Promise<void> {
    if (this.config.keepaliveIntervalMs <= 0) return
    const existing = await this.state.storage.getAlarm()
    if (existing !== null) return
    await this.state.storage.setAlarm(this.clock.now() + this.config.keepaliveIntervalMs)
  }

  private build(
    socket: PairSocket,
    id: string,
    origin: string,
    snapshot: SessionSnapshot | undefined,
    rendezvous: Rendezvous = new Rendezvous()
  ): PeerSession {
    const port: PeerSocket = {
      isOpen: () => socket.readyState === OPEN,
      sendText: (text) => socket.send(text),
      sendBinary: (payload) => socket.send(payload),
      // The runtime owns the send queue here and does not expose its depth, so
      // core's slow-consumer rule has nothing to measure and never fires. The
      // frame and byte budgets still do, and they are what bound the work.
      backlog: () => 0,
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.close(CloseCode.Protocol, 'terminated'),
      // No WebSocket-protocol ping is exposed to a Durable Object. Liveness is
      // the runtime's, and peers keep themselves alive with the control ping.
      ping: null
    }
    const host: SessionHost = {
      config: this.config,
      clock: this.clock,
      log: this.log,
      rendezvous,
      onClosed: () => {}
    }
    return new PeerSession(id, origin, port, host, snapshot)
  }
}
