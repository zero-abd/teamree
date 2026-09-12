// Wire protocol shared by the runtime, the renderer, and the CLI.
//
// Framing is newline-delimited JSON: one complete JSON value per line, UTF-8,
// no embedded raw newlines. A single connection carries interleaved responses
// and stream events, correlated by `id` and `stream` respectively.

import { z } from 'zod'

export const PROTOCOL_VERSION = 1

/** Stable error codes. Callers branch on these, never on message text. */
export const ErrorCode = {
  BadRequest: 'bad_request',
  UnknownMethod: 'unknown_method',
  InvalidParams: 'invalid_params',
  NotFound: 'not_found',
  Conflict: 'conflict',
  GitFailed: 'git_failed',
  TerminalFailed: 'terminal_failed',
  Internal: 'internal'
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const RequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional()
})

export type Request = z.infer<typeof RequestSchema>

export type SuccessResponse = { id: string; ok: true; result: unknown }

export type ErrorResponse = {
  id: string
  ok: false
  error: { code: ErrorCode; message: string; data?: unknown }
}

export type Response = SuccessResponse | ErrorResponse

/**
 * Server-pushed event on an active subscription. `stream` is the subscription
 * id returned by the subscribing call, not the request id.
 */
export type StreamEvent = { stream: string; event: unknown }

export type Frame = Response | StreamEvent

export function isStreamEvent(frame: Frame): frame is StreamEvent {
  return 'stream' in frame
}

/** Encodes one frame for the wire, including the trailing delimiter. */
export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Incremental newline-delimited JSON reader. Feed it arbitrary chunks; it
 * yields whole parsed values and buffers the partial tail.
 */
export function createFrameDecoder(): (chunk: string) => unknown[] {
  let buffer = ''
  return (chunk: string): unknown[] => {
    buffer += chunk
    const values: unknown[] = []
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) values.push(JSON.parse(line))
      newline = buffer.indexOf('\n')
    }
    return values
  }
}
