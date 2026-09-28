// What a pane's output may be kept as. Replayed output can make the emulator
// send bytes back (CPR, DA, ENQ) into a shell that never asked, or reach the
// clipboard and window title, so a record is reduced to an allowlist: text,
// whitespace controls and SGR. Allowlist, not denylist: the dangerous set is not closed.

import { markerLabel, markerText, markerTime } from '../../shared/paneMarker'
import { freshAgentLabel } from '../../shared/paneRestore'

/** One pane's kept output, and when this machine wrote it down. */
export type RecordedScrollback = {
  text: string
  /** When the record was taken, not when the pane stopped: a checkpoint of a running pane is neither. */
  recordedAt: number
  /** Written for a pane running in the pane host; see `HostedRecord`. */
  host?: HostedRecord
}

/**
 * A hosted pane's session in the pane host, and the record its output followed. A launch that finds
 * the session alive shows `before`, then the host's own replay, instead of `text`.
 */
export type HostedRecord = { session: string; before?: string }

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** The dim a pane's own asides are printed in. */
const DIM = `${ESC}[38;5;244m`
const RESET = `${ESC}[0m`

/** What is left once the sanitizer has run: text, the whitespace controls, and colour. */
export const INERT_RECORD = /^(?:[^\u0000-\u001f\u007f-\u009f]|[\n\r\t\u0008]|\u001b\[[0-9;:]*m)*$/u

/** One marker line (see `paneMarker.ts`), on a line of its own and in its own colour. */
function markerLine(label: string): string {
  return `${RESET}\r\n${DIM}${markerText(label)}${RESET}\r\n`
}

/** What follows a record read back on launch; the default. */
export const RESTORED = 'Restored'

/** What follows a record when a shell starts in place of the program that wrote it. */
export const NEW_SHELL_BELOW = 'New shell'

/** What follows an ended agent's record when it picks its conversation back up. */
export const RESUMED_BELOW = 'Resumed'

/** What follows it when the agent starts over. */
export const NEW_SESSION_BELOW = 'New session'

/** What follows a Run pane's record when its command runs again. */
export const RUN_AGAIN_BELOW = 'Restarted'

/** Nothing follows: the pane waits on its end block's buttons, which say it came back. */
export const NOT_RUN_AGAIN_BELOW = ''

/** What follows it when a resume did not take; `pty-session.ts` withholds the record until then. */
export const FAILED_RESUME_BELOW = RESTORED

/** The record, then a marker naming what follows it and when the record was taken. */
export function replayableRecord(record: RecordedScrollback, startsBelow?: string): string {
  return `${record.text}${closingMark(startsBelow, record.recordedAt)}`
}

/** The marker after a record: what starts below, and when. Empty for a pane whose end block says it. */
export function closingMark(startsBelow: string = RESTORED, at: number = Date.now()): string {
  return startsBelow === '' ? '' : markerLine(`${startsBelow} · ${markerTime(at)}`)
}

/** Said into a pane whose resume did not take; the agent's own reason sits immediately above. */
export function failedResumeMark(exitCode: number, restarted: boolean): string {
  return markerLine(`Resume refused · exit ${exitCode}${restarted ? ' · New session' : ''}`)
}

/** Said above a fresh agent when the store had nothing under the pinned id; why is not knowable, so not claimed. */
export function noConversationMark(agent: string): string {
  return markerLine(`Nothing to resume · ${freshAgentLabel(agent)}`)
}

/** A line 0.3 to 0.7 wrote as `[… — …]`, and the marker label it reads as now; null drops the line. */
const LEGACY_MARKS: readonly [RegExp, (match: RegExpExecArray) => string | null][] = [
  [/^\[record — up to [^\]]*, nothing running\]$/u, () => null],
  [/^\[end of record — not run again\]$/u, () => null],
  [/^\[end of record — new shell below\]$/u, () => NEW_SHELL_BELOW],
  [/^\[end of record — resume attempt below\]$/u, () => RESTORED],
  [/^\[end of record — .+ starts again below\]$/u, () => RUN_AGAIN_BELOW],
  [
    /^\[resume refused — agent exited (\d+)[^;\]]*; fresh agent below\]$/u,
    (m) => `Resume refused · exit ${m[1]} · New session`
  ],
  [/^\[resume refused — agent exited (\d+)[^\]]*\]$/u, (m) => `Resume refused · exit ${m[1]}`],
  [/^\[no conversation to resume — (.+) below\]$/u, (m) => `Nothing to resume · ${m[1]}`],
  [/^\[(.)(.*) — agent stopped, task not re-sent\]$/u, (m) => `${m[1]?.toUpperCase()}${m[2]} · not resumed`]
]

/**
 * A record with the bracketed lines older versions wrote into it turned into marker lines, or dropped where
 * nothing says them now. A stopped note at the very end goes too: the pane's end block says it.
 */
export function upgradedMarks(text: string): string {
  if (!text.includes(' — ') && !text.includes(' · not resumed')) return text
  type Line = { line: string; plain: string; label?: string | null; legacy?: true }
  const lines: Line[] = text.split('\n').map((line) => {
    const plain = line.replace(/\u001b\[[0-9;:]*m/gu, '').replace(/\r$/u, '')
    const label = markerLabel(plain)
    if (label !== null) return { line, plain, label }
    for (const [pattern, legacy] of LEGACY_MARKS) {
      const match = pattern.exec(plain)
      if (match !== null) return { line, plain, label: legacy(match), legacy: true }
    }
    return { line, plain }
  })
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = lines[index] as Line
    if (entry.label === undefined && entry.plain.trim() !== '') break
    if (entry.label?.endsWith(' · not resumed') === true) entry.label = null
  }
  return lines
    .flatMap(({ line, label, legacy }) => {
      if (label === null) return []
      if (legacy === undefined || label === undefined) return [line]
      return [`${DIM}${markerText(label)}${RESET}${line.endsWith('\r') ? '\r' : ''}`]
    })
    .join('\n')
}

/**
 * The output reduced to what it is safe to replay: text, whitespace controls, SGR, and
 * forward cursor moves as spaces. Applied on the way in and again on the way out.
 */
export function sanitizeRecordedOutput(text: string): string {
  let kept = ''
  let index = 0
  // Where the kept text has the cursor, so a dropped column move can become the spaces it skipped.
  let column = 0

  while (index < text.length) {
    const char = text[index] as string

    if (char === ESC) {
      const sequence = readEscape(text, index)
      if (sequence.keep !== undefined) kept += sequence.keep
      const pad = sequence.move === undefined ? 0 : forwardPad(sequence.move, column)
      kept += ' '.repeat(pad)
      column += pad
      index = sequence.end
      continue
    }

    // CR is how a progress line overwrote itself; BS is how a spinner erased a frame.
    if (char === '\n' || char === '\r' || char === '\t' || char === '\b') {
      kept += char
      if (char === '\r') column = 0
      else if (char === '\t') column = (Math.floor(column / 8) + 1) * 8
      else if (char === '\b') column = Math.max(0, column - 1)
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
    // The second half of a surrogate pair is the same cell.
    if (code < 0xdc00 || code > 0xdfff) column += 1
    index += 1
  }

  return kept
}

/** Past this a forward move is a probe for the right edge (`ESC[999C`), not a gap between words. */
const LAYOUT_COLUMNS = 300

/** The spaces a forward move skipped over, from `column`; none for a move back or a probe. */
function forwardPad(move: { to: 'column' | 'right'; by: number }, column: number): number {
  const target = move.to === 'right' ? column + move.by : move.by - 1
  return target > column && target <= LAYOUT_COLUMNS ? target - column : 0
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

/** One escape sequence: where it ends, what of it is worth keeping, and a forward cursor move it made. */
type Escape = { end: number; keep?: string; move?: { to: 'column' | 'right'; by: number } }

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
    // CUF, CHA and HPA: how agents that draw with the cursor put the spaces between words.
    if (/^\d*$/.test(csi.params) && (csi.final === 'C' || csi.final === 'G' || csi.final === '`')) {
      const by = Math.max(1, Number(csi.params || '1'))
      return { end: csi.end, move: { to: csi.final === 'C' ? 'right' : 'column', by } }
    }
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
