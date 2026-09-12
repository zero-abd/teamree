// An in-process stand-in for the real runtime, used by the tests: a real unix
// socket speaking the real protocol, so the transport is exercised end to end
// rather than against a mock.

import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFrameDecoder, encodeFrame, type Frame } from '../shared/protocol.js'

/** Return this from a handler to model a runtime that never answers. */
export const NO_REPLY = Symbol('no-reply')

export type StubContext = {
  id: string
  /** Pushes a stream event on the connection that made the call. */
  emit: (stream: string, event: unknown) => void
  /** Answers any request id, so a handler can reply out of order. */
  respond: (id: string, result: unknown) => void
}

export type StubHandler = (method: string, params: unknown, context: StubContext) => unknown

export type StubRuntime = {
  endpoint: string
  /** Every request the stub received, in order. */
  received: Array<{ id: string; method: string; params: unknown }>
  close: () => Promise<void>
}

/** Throw this from a handler to send a protocol error response. */
export class StubError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

let counter = 0

export function stubEndpointPath(): string {
  counter += 1
  return join(tmpdir(), `tmr-stub-${process.pid}-${counter}.sock`)
}

export async function startStubRuntime(handler: StubHandler): Promise<StubRuntime> {
  const endpoint = stubEndpointPath()
  const received: StubRuntime['received'] = []
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))

    const decode = createFrameDecoder()
    const write = (frame: Frame): void => {
      if (!socket.destroyed) socket.write(encodeFrame(frame))
    }

    socket.on('data', (chunk: string) => {
      for (const value of decode(chunk)) {
        const request = value as { id: string; method: string; params?: unknown }
        received.push({ id: request.id, method: request.method, params: request.params })
        try {
          const result = handler(request.method, request.params, {
            id: request.id,
            emit: (stream, event) => write({ stream, event }),
            respond: (id, value) => write({ id, ok: true, result: value })
          })
          if (result === NO_REPLY) continue
          write({ id: request.id, ok: true, result })
        } catch (error) {
          const code = error instanceof StubError ? error.code : 'internal'
          write({ id: request.id, ok: false, error: { code: code as never, message: (error as Error).message } })
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => resolve())
  })

  return {
    endpoint,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}
