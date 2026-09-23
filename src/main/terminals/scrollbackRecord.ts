// What a pane's output may be kept as. Replayed output can make the emulator
// send bytes back (CPR, DA, ENQ) into a shell that never asked, or reach the
// clipboard and window title, so a record is reduced to an allowlist: text,
// whitespace controls and SGR. Allowlist, not denylist: the dangerous set is not closed.

import { freshAgentLabel } from '../../shared/paneRestore'

/** One pane's kept output, and when this machine wrote it down. */
export type RecordedScrollback = {
  text: string
  /** When the record was taken, not when the pane stopped: a checkpoint of a running pane is neither. */
  recordedAt: number
}

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** The dim a pane's own asides are printed in; see TerminalView's exit line. */
const DIM = `${ESC}[38;5;244m`
const RESET = `${ESC}[0m`

/** What is left once the sanitizer has run: text, the whitespace controls, and colour. */
export const INERT_RECORD = /^(?:[^\u0000-\u001f\u007f-\u009f]|[\n\r\t\u0008]|\u001b\[[0-9;:]*m)*$/u

/**
 * The record as written into a restored pane, between two marks said in words
 * so nobody takes a record for a running process. `startsBelow` names what
 * follows, which is not always a new shell.
 */
export function replayableRecord(record: RecordedScrollback, startsBelow?: string): string {
  return `${openingMark(record.recordedAt)}${record.text}${closingMark(startsBelow)}`
}

/** What follows a record in the ordinary case: the command was not re-issued, a shell starts. */
export const NEW_SHELL_BELOW = 'new shell below'

/** What follows it when a resume did not take; `pty-session.ts` withholds the record until then. */
export const FAILED_RESUME_BELOW = 'resume attempt below'

/** What follows it when an exited pane runs its program again: "again", not "resumed" — a fresh conversation. */
export function startsAgainBelow(program: string): string {
  return `${program} starts again below`
}

/**
 * Said into a pane whose resume did not take: only what the app knows. The
 * agent's own reason sits immediately above. `restarted` is told, not guessed.
 */
export function failedResumeMark(exitCode: number, hasRecord: boolean, restarted: boolean): string {
  const kept = hasRecord ? ', record above' : ''
  const next = restarted ? 'fresh agent below' : 'open a new pane for a fresh one'
  return `${RESET}\r\n${DIM}[resume refused — agent exited ${exitCode}${kept}; ${next}]${RESET}\r\n`
}

/**
 * Said above a fresh agent when the store had nothing under the pinned id:
 * "we looked" is a different line from "it refused". Why it is absent is not
 * knowable from outside, so it is not claimed.
 */
export function noConversationMark(agent: string): string {
  return `${RESET}\r\n${DIM}[no conversation to resume — ${freshAgentLabel(agent)} below]${RESET}\r\n`
}

/**
 * Said before the record. "Up to" and not "until": the time is when this was
 * written down, and a checkpoint precedes the pane's last line.
 */
export function openingMark(recordedAt: number): string {
  return `${RESET}${DIM}[record — up to ${clockLabel(recordedAt)}, nothing running]${RESET}\r\n`
}

/** Said after it, which is the line somebody reads on the way down. */
export function closingMark(startsBelow: string = NEW_SHELL_BELOW): string {
  return `${RESET}\r\n${DIM}[end of record — ${startsBelow}]${RESET}\r\n`
}

/** Local wall-clock, to the minute. Absolute: a relative label computed once goes quietly wrong. */
export function clockLabel(at: number): string {
  const when = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  )
}

/**
 * The output reduced to what it is safe to replay: text, whitespace controls,
 * SGR. Applied on the way in and again on the way out: the file is the boundary.
 */
export function sanitizeRecordedOutput(text: string): string {
  let kept = ''
  let index = 0

  while (index < text.length) {
    const char = text[index] as string

    if (char === ESC) {
      const sequence = readEscape(text, index)
      if (sequence.keep !== undefined) kept += sequence.keep
      index = sequence.end
      continue
    }

    // CR is how a progress line overwrote itself; BS is how a spinner erased a frame.
    if (char === '\n' || char === '\r' || char === '\t' || char === '\b') {
      kept += char
      index += 1
      continue
    }

    // C1 introducers take their payload with them, or `6n` is left as text.
    const code = char.charCodeAt(0)
    if (code === 0x9b) {
      index = scanCsi(text, index + 1).end
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = endOfString(text, index + 1)
      continue
    }

    // BEL rings, ENQ answers back, SO and SI switch character sets.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1
      continue
    }

    kept += char
    index += 1
  }

  return kept
}

/**
 * The trailing `capBytes` of `text`, from the next line boundary: half a colour
 * sequence is an escape left waiting to swallow whatever follows it.
 */
export function tailFromLineBoundary(text: string, capBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= capBytes) return text

  let start = buffer.byteLength - capBytes
  // A cut inside a multi-byte character would decode to a replacement one.
  while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++
  const cut = buffer.subarray(start).toString('utf8')
  const newline = cut.indexOf('\n')
  return newline === -1 ? cut : cut.slice(newline + 1)
}

/** One escape sequence: where it ends, and what of it is worth keeping. */
type Escape = { end: number; keep?: string }

/**
 * Consumes the sequence at `start`. Only a CSI ending in `m` with plain digit
 * parameters survives — not a private-parameter `m`. A cut-off sequence is dropped whole.
 */
function readEscape(text: string, start: number): Escape {
  const next = text[start + 1]
  if (next === undefined) return { end: text.length }

  if (next === '[') {
    const csi = scanCsi(text, start + 2)
    if (csi.final === 'm' && /^[0-9;:]*$/.test(csi.params)) return { end: csi.end, keep: text.slice(start, csi.end) }
    return { end: csi.end }
  }

  // OSC, DCS, SOS, PM, APC: the whole payload goes.
  if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
    return { end: endOfString(text, start + 2) }
  }

  // The short escapes: ESC c, ESC ( B, ESC =. None of them is output.
  let index = start + 1
  while (index < text.length && (text[index] as string) >= ' ' && (text[index] as string) <= '/') index++
  return { end: Math.min(index + 1, text.length) }
}

/** Consumes a CSI from just after its introducer to its final byte; none means the tail cut it in half. */
function scanCsi(text: string, from: number): { end: number; final?: string; params: string } {
  let index = from
  while (index < text.length) {
    const char = text[index] as string
    if (char >= '@' && char <= '~') return { end: index + 1, final: char, params: text.slice(from, index) }
    index++
  }
  return { end: text.length, params: text.slice(from) }
}

/** Where a string sequence ends: BEL, ESC backslash, or the C1 terminator. */
function endOfString(text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const char = text[index] as string
    if (char === BEL || char === ST_C1) return index + 1
    if (char === ESC && text[index + 1] === '\\') return index + 2
    index++
  }
  return text.length
}
