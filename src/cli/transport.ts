// The wire client. One socket carries every request for the process lifetime;
// responses are matched by id and stream events by subscription id, because the
// runtime may interleave them freely on the same connection.

import { createConnection, type Socket } from 'node:net'
import type { MethodName, ParamsOf, ResultOf } from '../shared/methods.js'
import {
  createFrameDecoder,
  encodeFrame,
  isStreamEvent,
  type ErrorResponse,
  type Frame,
  type Request,
  type Response,
  type StreamEvent
} from '../shared/protocol.js'
import { CliError, ExitCode, NoRuntimeError, RuntimeCallError } from './exit.js'

export const DEFAULT_TIMEOUT_MS = 15_000

export type Subscription = {
  id: string
  unsubscribe: () => Promise<void>
}

export type RuntimeClient = {
  readonly endpoint: string
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>
  /** Subscribes and routes every pushed event to `onEvent` until unsubscribed. */
  subscribe<M extends MethodName>(method: M, params: ParamsOf<M>, onEvent: (event: unknown) => void): Promise<Subscription>
  close(): void
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: string
}

const CONNECT_HINT =
  'Start the teamree desktop app (npm run dev in the repo, or launch the installed app), then retry.'

/** Narrows a decoded value to a frame; anything else is a protocol violation. */
export function classifyFrame(value: unknown): Frame | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record['stream'] === 'string') return value as StreamEvent
  if (typeof record['id'] === 'string' && typeof record['ok'] === 'boolean') return value as Response
  return null
}

export type ConnectOptions = {
  endpoint: string
  /** Per-request budget, also used for the initial connect. */
  timeoutMs?: number
}

export function connectRuntime(options: ConnectOptions): Promise<RuntimeClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RuntimeClient>((resolve, reject) => {
    const socket: Socket = createConnection({ path: options.endpoint })
    socket.setNoDelay(true)
    socket.setEncoding('utf8')

    const pending = new Map<string, Pending>()
    const streams = new Map<string, (event: unknown) => void>()
    // Events can land before the subscribing call's response is handled, so
    // hold them until a handler claims that subscription id.
    const orphanEvents = new Map<string, unknown[]>()
    const decode = createFrameDecoder()

    let connected = false
    let closed = false
    let nextId = 0

    const connectTimer = setTimeout(() => {
      socket.destroy()
      reject(
        new NoRuntimeError(
          `Timed out after ${timeoutMs}ms connecting to the teamree runtime at ${options.endpoint}.`,
          CONNECT_HINT
        )
      )
    }, timeoutMs)
    connectTimer.unref?.()

    const failAllPending = (error: Error): void => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.reject(error)
      }
    }

    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!connected) {
        clearTimeout(connectTimer)
        reject(describeConnectFailure(error, options.endpoint))
        return
      }
      failAllPending(
        new CliError({
          code: 'connection_lost',
          message: `Connection to the teamree runtime failed: ${error.message}`,
          exitCode: ExitCode.Failure
        })
      )
    })

    socket.on('close', () => {
      closed = true
      failAllPending(
        new CliError({
          code: 'connection_closed',
          message: 'The teamree runtime closed the connection before answering.',
          exitCode: ExitCode.Failure
        })
      )
    })

    socket.on('data', (chunk: string) => {
      let values: unknown[]
      try {
        values = decode(chunk)
      } catch (error) {
        socket.destroy()
        failAllPending(
          new CliError({
            code: 'protocol_error',
            message: `The teamree runtime sent an unparseable frame: ${(error as Error).message}`,
            exitCode: ExitCode.Failure
          })
        )
        return
      }

      for (const value of values) {
        const frame = classifyFrame(value)
        if (!frame) continue

        if (isStreamEvent(frame)) {
          const handler = streams.get(frame.stream)
          if (handler) handler(frame.event)
          else orphanEvents.set(frame.stream, [...(orphanEvents.get(frame.stream) ?? []), frame.event])
          continue
        }

        const entry = pending.get(frame.id)
        if (!entry) continue
        clearTimeout(entry.timer)
        pending.delete(frame.id)
        if (frame.ok) entry.resolve(frame.result)
        else entry.reject(toCallError(frame, entry.method))
      }
    })

    const send = (method: string, params: unknown): Promise<unknown> => {
      if (closed) {
        return Promise.reject(
          new CliError({
            code: 'connection_closed',
            message: 'The connection to the teamree runtime is already closed.',
            exitCode: ExitCode.Failure
          })
        )
      }
      const id = `cli-${++nextId}`
      const request: Request = { id, method, params }
      return new Promise<unknown>((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectCall(
            new CliError({
              code: 'timeout',
              message: `${method} did not answer within ${timeoutMs}ms.`,
              exitCode: ExitCode.Failure,
              hint: 'Raise the budget with --timeout <ms> if the operation is genuinely slow.'
            })
          )
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer, method })
        // Requests share the frame encoder: the protocol's framing is one JSON
        // value per line in both directions, even though `Frame` names only the
        // server's half.
        socket.write(encodeFrame(request as unknown as Frame))
      })
    }

    const client: RuntimeClient = {
      endpoint: options.endpoint,
      call: async <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => {
        const result = await send(method, params)
        return result as ResultOf<M>
      },
      subscribe: async <M extends MethodName>(method: M, params: ParamsOf<M>, onEvent: (event: unknown) => void) => {
        const result = await send(method, params)
        const id = readSubscriptionId(result)
        streams.set(id, onEvent)
        for (const event of orphanEvents.get(id) ?? []) onEvent(event)
        orphanEvents.delete(id)
        return {
          id,
          unsubscribe: async (): Promise<void> => {
            streams.delete(id)
            await send('unsubscribe', { subscription: id })
          }
        }
      },
      close: () => {
        closed = true
        clearTimeout(connectTimer)
        for (const entry of pending.values()) clearTimeout(entry.timer)
        pending.clear()
        socket.destroy()
      }
    }

    socket.on('connect', () => {
      connected = true
      clearTimeout(connectTimer)
      resolve(client)
    })
  })
}

function readSubscriptionId(result: unknown): string {
  const id = typeof result === 'object' && result !== null ? (result as Record<string, unknown>)['subscription'] : undefined
  if (typeof id !== 'string' || id.length === 0) {
    throw new CliError({
      code: 'protocol_error',
      message: 'The runtime did not return a subscription id.',
      exitCode: ExitCode.Failure,
      data: result
    })
  }
  return id
}

function toCallError(frame: ErrorResponse, method: string): RuntimeCallError {
  return new RuntimeCallError({
    code: frame.error.code,
    message: `${method}: ${frame.error.message}`,
    data: frame.error.data
  })
}

/** ENOENT and friends mean nothing is listening, which is exit code 3, not 1. */
export function describeConnectFailure(error: NodeJS.ErrnoException, endpoint: string): CliError {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES') {
    return new NoRuntimeError(
      `No teamree runtime is listening at ${endpoint} (${error.code}).`,
      CONNECT_HINT,
      { endpoint, errno: error.code }
    )
  }
  return new CliError({
    code: 'connect_failed',
    message: `Could not connect to the teamree runtime at ${endpoint}: ${error.message}`,
    exitCode: ExitCode.Failure
  })
}
