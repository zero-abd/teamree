// The CLI-facing transport. Every client gets its own connection id, its own
// frame decoder, and its own subscription scope, so one misbehaving client can
// never corrupt another's stream or outlive its own process.
//
// Unlike the peer transport, this one is not an allow-list of anything: a client
// here is the user, and it reaches every method the window reaches. So the
// question this file has to answer is not which methods a caller may use but
// *who may become a caller*, and the answer is the mode below.

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
 * Owner read/write and nothing else, like `PRIVATE_KEY_MODE` beside the one
 * secret in the product — and for the same reason, which is that the thing it
 * guards is worth more than the directory it happens to be sitting in.
 *
 * `listen` leaves the mode to whatever umask this process inherited: 0755 from
 * a launch out of Finder, 0777 from a shell whose profile sets `umask 000`.
 * Neither is a decision anybody made about this socket. It matters because
 * connect(2) on a unix socket is an authorisation check — the kernel wants
 * *write* permission on the file — so the inherited mode is the whole of who
 * may drive this machine's runtime, and one of those two values hands it to
 * every account on the box.
 *
 * On an ordinary single-user Mac that is theoretical twice over: the endpoint
 * is `~/Library/Application Support/teamree/runtime.sock`, and both that
 * directory (Electron creates it 0700) and `~/Library` itself are closed to
 * other accounts, so nothing can reach the file to be judged by its mode. The
 * reason this line exists anyway is that the endpoint is not always there.
 * `resolveEndpoint` falls back to the temp directory and then to `/tmp` when
 * the user data path would not fit in `sun_path`, and `/tmp` is a directory
 * every account on the machine can walk into. That fallback chain is pinned in
 * `tests/platform/socket-endpoint.test.ts`, so it is a supported path rather
 * than a hypothetical one. This is the defence for the case where the enclosing
 * directory is not a defence at all: it makes the
 * answer a property of the app rather than of where the socket landed and what
 * the shell's umask happened to be.
 *
 * What it does not defend against is anything already running as this user, and
 * that is not a gap this mode could close — see `docs/local-access.md`.
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
        // The stream position is unrecoverable after a bad line, so say why and
        // hang up rather than silently interpreting the remaining bytes.
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
    // A named pipe in use always means a live owner; a socket file usually means
    // a crashed one, and only a failed connect proves it.
    if (!isAddressInUse(error) || isPipeEndpoint(endpoint)) throw error
    if (await isEndpointAlive(endpoint)) throw error
  }

  await rm(endpoint, { force: true })
  await listen(server, endpoint)
}

/**
 * Shuts the endpoint to every account but this one, and refuses to serve from
 * it at all if it cannot.
 *
 * The gap between binding and this is real, because node takes no mode when it
 * listens and there is nowhere earlier to put it. It is two consecutive calls
 * wide, and reaching it means already waiting on a path you guessed. Failing
 * closed is the part that earns its keep: a socket whose mode could not be set
 * is the one thing `ENDPOINT_MODE` says cannot exist, and serving from it anyway
 * would leave that written down and false. `startRuntime` reports the failure
 * and carries on — the window works without a CLI endpoint.
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
