// The CLI-facing transport. Every client gets its own connection id, decoder and
// subscription scope. A client here is the user and reaches every method, so the
// question is *who may become a caller*, and the answer is the mode below.

import { createServer, connect, type Server, type Socket } from 'node:net'
import { chmod, rm } from 'node:fs/promises'
import { ErrorCode, createFrameDecoder, encodeFrame, type Frame } from '../../shared/protocol'
import type { Dispatcher } from './dispatcher'
import { isPipeEndpoint } from './socketEndpoint'
import type { SubscriptionHub } from './subscriptionHub'

export type SocketServerOptions = {
  endpoint: string
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
  /** Connection-level failures, which are expected and must not crash the app. */
  onError?: (error: unknown) => void
}

/**
 * Owner read/write only. `listen` leaves the mode to the inherited umask, and
 * connect(2) on a unix socket wants *write* permission, so with the `/tmp`
 * fallback in `resolveEndpoint` a 0777 umask would hand the runtime to every
 * account on the box. Not a defence against this user's own processes; see `docs/local-access.md`.
 */
export const ENDPOINT_MODE = 0o600

export type RuntimeSocketServer = {
  readonly endpoint: string
  connectionCount: () => number
  close: () => Promise<void>
}

export async function startSocketServer(options: SocketServerOptions): Promise<RuntimeSocketServer> {
  const { endpoint, dispatch, subscriptions, onError } = options
  const sockets = new Set<Socket>()
  let nextConnectionId = 0

  const server = createServer((socket) => {
    nextConnectionId += 1
    const connectionId = `socket_${nextConnectionId}`
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.setNoDelay(true)

    const write = (frame: Frame): void => {
      if (socket.destroyed || socket.writableEnded) return
      socket.write(encodeFrame(frame))
    }

    subscriptions.openConnection(connectionId, write)
    const decode = createFrameDecoder()

    socket.on('data', (chunk: Buffer | string) => {
      // setEncoding keeps multi-byte characters whole across chunk boundaries.
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let values: unknown[]
      try {
        values = decode(text)
      } catch (error) {
        // The stream position is unrecoverable after a bad line, so say why and hang up.
        write({ id: '', ok: false, error: { code: ErrorCode.BadRequest, message: 'malformed JSON frame' } })
        onError?.(error)
        socket.destroy()
        return
      }
      for (const value of values) {
        void dispatch(value, { connectionId }).then(write, (error: unknown) => onError?.(error))
      }
    })

    const teardown = (): void => {
      sockets.delete(socket)
      subscriptions.closeConnection(connectionId)
    }
    socket.on('close', teardown)
    socket.on('error', (error) => {
      onError?.(error)
      socket.destroy()
    })
  })

  server.on('error', (error) => onError?.(error))
  await listenWithStaleRecovery(server, endpoint)
  await restrictEndpoint(server, endpoint)

  return {
    endpoint,
    connectionCount: () => sockets.size,
    close: async () => {
      // Copied first: destroy fires 'close', which removes the socket from the set.
      for (const socket of [...sockets]) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (!isPipeEndpoint(endpoint)) await rm(endpoint, { force: true }).catch(() => {})
    }
  }
}

async function listenWithStaleRecovery(server: Server, endpoint: string): Promise<void> {
  try {
    await listen(server, endpoint)
    return
  } catch (error) {
    // A named pipe in use means a live owner; a socket file usually means a
    // crashed one, and only a failed connect proves it.
    if (!isAddressInUse(error) || isPipeEndpoint(endpoint)) throw error
    if (await isEndpointAlive(endpoint)) throw error
  }

  await rm(endpoint, { force: true })
  await listen(server, endpoint)
}

/**
 * Shuts the endpoint to every account but this one, failing closed: node takes
 * no mode when it listens, and serving from a socket whose mode could not be
 * set would make `ENDPOINT_MODE` a lie. `startRuntime` reports and carries on.
 */
async function restrictEndpoint(server: Server, endpoint: string): Promise<void> {
  if (isPipeEndpoint(endpoint)) return
  try {
    await chmod(endpoint, ENDPOINT_MODE)
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(endpoint, { force: true }).catch(() => {})
    throw error
  }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown): void => reject(error)
    server.once('error', onError)
    server.listen(endpoint, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
}

/** True only if something accepts a connection on the endpoint right now. */
export function isEndpointAlive(endpoint: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(endpoint)
    const finish = (alive: boolean): void => {
      probe.destroy()
      resolve(alive)
    }
    probe.setTimeout(timeoutMs, () => finish(false))
    probe.once('connect', () => finish(true))
    probe.once('error', () => finish(false))
  })
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EADDRINUSE'
}
