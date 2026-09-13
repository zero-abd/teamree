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
 * The most a single frame may be before the sender is treated as broken.
 *
 * Generous against anything this protocol legitimately carries — a diff, a
 * scrollback — and far below what it costs to matter. A caller reading from
 * somewhere it does not trust should pass something tighter.
 */
export const DEFAULT_MAX_FRAME_CHARS = 32 * 1024 * 1024

/**
 * Incremental newline-delimited JSON reader. Feed it arbitrary chunks; it
 * yields whole parsed values and buffers the partial tail.
 *
 * Two things here are load-bearing rather than incidental, and both exist
 * because a sender that never sends a newline used to be able to hang the
 * process reading it. The tail is searched from where the last search ended
 * rather than from the start, so a growing buffer costs its own length once
 * instead of once per chunk — the difference between linear and quadratic, and
 * measured at 16 seconds of a pegged main thread for 52MB before this. And the
 * tail is capped, so a sender that never completes a frame is a sender that
 * gets dropped rather than one that is buffered until the runtime falls over.
 */
export function createFrameDecoder(maxFrameChars: number = DEFAULT_MAX_FRAME_CHARS): (chunk: string) => unknown[] {
  // The tail is kept as the chunks it arrived in and only joined when a frame
  // actually completes. Appending to one string instead looks equivalent and is
  // not: `+=` builds a rope, and every `indexOf` on that rope flattens the whole
  // thing, so a sender that never sends a newline costs the accumulated length
  // again on every chunk. Measured before this: 52MB of newline-free input took
  // 18 seconds of a pegged main thread, which owns every PTY and the window's
  // IPC. Searching only the chunk that just arrived is enough, because the
  // separator is a single character and so cannot straddle two of them.
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
      // Thrown rather than truncated: half a frame is not a frame, and a reader
      // that silently resynchronises mid-stream is one that can be made to parse
      // the sender's choice of boundary.
      pending = []
      pendingChars = 0
      throw new Error(`frame exceeded ${maxFrameChars} characters without completing`)
    }
    return values
  }
}
