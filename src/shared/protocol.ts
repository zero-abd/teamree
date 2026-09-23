// Wire protocol shared by the runtime, the renderer, and the CLI. Framing is
// newline-delimited JSON (one value per line, UTF-8, no raw newlines); one
// connection interleaves responses and stream events, correlated by `id` and `stream`.

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
 * The most a single frame may be before the sender is treated as broken. Generous
 * against a diff or a scrollback; a caller reading an untrusted source should pass tighter.
 */
export const DEFAULT_MAX_FRAME_CHARS = 32 * 1024 * 1024

/**
 * Incremental newline-delimited JSON reader: feed it chunks, it yields whole values
 * and buffers the tail. The tail is capped so a sender that never completes a frame is dropped.
 */
export function createFrameDecoder(maxFrameChars: number = DEFAULT_MAX_FRAME_CHARS): (chunk: string) => unknown[] {
  // Kept as chunks, joined only when a frame completes: `+=` builds a rope that
  // every `indexOf` flattens, quadratic on newline-free input (52MB pegged the
  // main thread for 18s). Searching only the new chunk is enough: a one-char
  // separator cannot straddle two.
  let pending: string[] = []
  let pendingChars = 0
  return (chunk: string): unknown[] => {
    const values: unknown[] = []
    let rest = chunk
    let newline = rest.indexOf('\n')
    while (newline !== -1) {
      const head = rest.slice(0, newline)
      const line = (pendingChars === 0 ? head : pending.join('') + head).trim()
      pending = []
      pendingChars = 0
      rest = rest.slice(newline + 1)
      if (line) values.push(JSON.parse(line))
      newline = rest.indexOf('\n')
    }
    if (rest.length > 0) {
      pending.push(rest)
      pendingChars += rest.length
    }
    if (pendingChars > maxFrameChars) {
      // Thrown rather than truncated: a reader that resynchronises mid-stream
      // can be made to parse the sender's choice of boundary.
      pending = []
      pendingChars = 0
      throw new Error(`frame exceeded ${maxFrameChars} characters without completing`)
    }
    return values
  }
}
