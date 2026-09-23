// Picks the one line of a terminal's output worth putting on a sidebar row or
// in a notification; shared so the window and the main process cannot drift.
// Evidence, not status: all teamree has is what a program printed. The tail is
// replayed onto a line buffer as a terminal would, then filtered for lines
// that would tell a reader nothing.

/** Cap on the returned line. The row ellipsises visually; this stops a program
 *  that prints a megabyte without a newline from reaching the DOM at all. */
export const EVIDENCE_MAX_CHARS = 140

/** How far back to look for a usable line. A run of blank lines, a banner of
 *  box-drawing and a prompt can easily bury the last real output this deep. */
const MAX_LINES_SCANNED = 60

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** Trailing glyphs a shell prompt ends with, across the common shells. */
const PROMPT_GLYPHS = '$%#>❯➜»'

/** The two of those that also appear at the end of ordinary output. */
const AMBIGUOUS_GLYPHS = '%>'

/** The last line of `output` that says something, or null when nothing is worth showing. */
export function evidenceLine(output: string, maxChars: number = EVIDENCE_MAX_CHARS): string | null {
  if (output.length === 0) return null

  // A full-screen program addresses the whole grid; one row of it means nothing.
  if (inAlternateScreen(output)) return null

  const lines = replayLines(output)
  const first = Math.max(0, lines.length - MAX_LINES_SCANNED)
  for (let index = lines.length - 1; index >= first; index--) {
    const candidate = tidy(lines[index] ?? '')
    if (candidate.length > 0 && !isUninformative(candidate)) return truncate(candidate, maxChars)
  }
  return null
}

/**
 * Replays the stream onto a line buffer as a terminal would (CR, backspace,
 * erase-line), so a progress line collapses to its final state. Cursor
 * addressing between rows is not emulated: a half-emulated grid is confident nonsense.
 */
export function replayLines(output: string): string[] {
  const lines: string[] = []
  let line = ''
  let cursor = 0

  const write = (text: string): void => {
    if (cursor > line.length) line = line.padEnd(cursor, ' ')
    line = line.slice(0, cursor) + text + line.slice(cursor + text.length)
    cursor += text.length
  }

  for (let index = 0; index < output.length; index++) {
    const char = output[index] as string

    if (char === ESC) {
      const sequence = readEscape(output, index)
      index = sequence.end
      switch (sequence.final) {
        case 'K':
          if (sequence.params === '' || sequence.params === '0') line = line.slice(0, cursor)
          else if (sequence.params === '1') line = ' '.repeat(Math.min(cursor, line.length)) + line.slice(cursor)
          else if (sequence.params === '2') line = ''
          break
        case 'C':
          cursor += count(sequence.params)
          break
        case 'D':
          cursor = Math.max(0, cursor - count(sequence.params))
          break
        case 'G':
          cursor = Math.max(0, count(sequence.params) - 1)
          break
        default:
          break
      }
      continue
    }

    switch (char) {
      case '\n':
        lines.push(line)
        line = ''
        cursor = 0
        break
      case '\r':
        cursor = 0
        break
      case '\b':
        cursor = Math.max(0, cursor - 1)
        break
      case '\t':
        // Columns mean nothing on a sidebar row, so a tab is spacing.
        write(' ')
        break
      default:
        // Remaining C0 and DEL are signalling, not text.
        if (char >= ' ' && char !== '\x7f') write(char)
        break
    }
  }

  lines.push(line)
  return lines
}

/** One escape sequence: where it ends, and — for a CSI — what it asked for. */
type EscapeSequence = { end: number; final?: string; params?: string }

/**
 * Consumes the escape sequence at `start`. Only sequences that change what a
 * line holds are reported: erase-line and the three horizontal cursor moves.
 */
function readEscape(output: string, start: number): EscapeSequence {
  const next = output[start + 1]
  if (next === undefined) return { end: start }

  if (next === '[') {
    let index = start + 2
    let params = ''
    // CSI runs through parameter and intermediate bytes to a final byte in
    // 0x40..0x7e; running out first means the tail cut the sequence in half.
    while (index < output.length) {
      const char = output[index] as string
      if (char >= '\x40' && char <= '\x7e') return { end: index, final: char, params }
      params += char
      index++
    }
    return { end: output.length }
  }

  if (next === ']') {
    // OSC payload, terminated by BEL or by either form of ST.
    let index = start + 2
    while (index < output.length) {
      const char = output[index] as string
      if (char === BEL || char === ST_C1) return { end: index }
      if (char === ESC && output[index + 1] === '\\') return { end: index + 1 }
      index++
    }
    return { end: output.length }
  }

  // Two-character escapes (charset selection, keypad modes, ESC 7/8 and so on).
  return { end: start + 1 }
}

/** A cursor move's repeat count; an omitted parameter means one. */
function count(params: string | undefined): number {
  const parsed = Number.parseInt(params ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/** True when the tail ends inside the alternate screen buffer: a full-screen program owns the grid. */
function inAlternateScreen(output: string): boolean {
  const entered = Math.max(output.lastIndexOf(`${ESC}[?1049h`), output.lastIndexOf(`${ESC}[?47h`))
  if (entered === -1) return false
  const left = Math.max(output.lastIndexOf(`${ESC}[?1049l`), output.lastIndexOf(`${ESC}[?47l`))
  return left < entered
}

/** Braille spinner frames, which would make a stable row flicker for nothing. */
const LEADING_SPINNER = /^[⠀-⣿]+[ \t]+/

function tidy(line: string): string {
  return line.replace(LEADING_SPINNER, '').replace(/\s+/g, ' ').trim()
}

/** A line with nothing to act on: a bare prompt, a rule, a spinner frame on its own. */
function isUninformative(line: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(line)) return true
  return isBarePrompt(line)
}

function isBarePrompt(line: string): boolean {
  const glyph = line[line.length - 1] as string
  if (!PROMPT_GLYPHS.includes(glyph)) return false

  const head = line.slice(0, -1)
  // "45%" and "step 3 >" end in a prompt glyph too, so these two only read as a
  // prompt after whitespace or punctuation; "$" sits directly against a bash path.
  if (AMBIGUOUS_GLYPHS.includes(glyph) && /[\p{L}\p{N}]$/u.test(head)) return false
  // A prompt is a location, not a sentence; two words covers "[user@host dir]#" plus a virtualenv prefix.
  return head.length <= 80 && head.trim().split(/\s+/).filter(Boolean).length <= 2
}

function truncate(line: string, maxChars: number): string {
  return line.length <= maxChars ? line : `${line.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}
