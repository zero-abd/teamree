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

  return evidenceInRows(replayLines(output), maxChars)
}

/** The last of `rows` that says something: `replayLines`' output, or the rows of an emulator's screen. */
export function evidenceInRows(rows: readonly string[], maxChars: number = EVIDENCE_MAX_CHARS): string | null {
  const first = Math.max(0, rows.length - MAX_LINES_SCANNED)
  const prompt = livePrompt(rows, first)
  for (let index = rows.length - 1; index >= first; index--) {
    const candidate = typedAt(tidy(rows[index] ?? ''), prompt)
    if (candidate.length === 0 || isUninformative(candidate)) continue

    const head = messageHead(rows, index, first)
    if (head === null) return truncate(candidate, maxChars)
    const headRow = (rows[head] ?? '').trim()
    // A recap or a composer is not output, and neither is anything indented under it.
    if (CHROME_HEAD.test(headRow)) {
      index = head
      continue
    }
    const said = tidy(headRow)
    return truncate(LEADING_BULLET.test(headRow) && !isUninformative(said) ? said : candidate, maxChars)
  }
  return null
}

/** The shell's own prompt, read off the last bare prompt on screen; null when it names nothing. */
function livePrompt(rows: readonly string[], first: number): string | null {
  for (let index = rows.length - 1; index >= first; index--) {
    const line = tidy(rows[index] ?? '')
    if (isBarePrompt(line)) return /[\p{L}\p{N}]/u.test(line) ? line : null
  }
  return null
}

/** A prompt's user@host, folder or path, and its glyph, when a command follows it on the line. */
const PROMPT_HEAD = /^(?:\([^()\s]+\) )?(?:\[[^\]\s]+@[^\]]+\]|[\w.-]+@[\w.-]+(?::\S*| \S+)?|[~/]\S*) ?[$%#❯➜»] (?=\S)/u

/** What was typed at a prompt, without the prompt; any other line as it is. */
function typedAt(line: string, prompt: string | null): string {
  if (prompt !== null && line.startsWith(`${prompt} `)) return line.slice(prompt.length + 1)
  const head = PROMPT_HEAD.exec(line)
  return head === null ? line : line.slice(head[0].length)
}

/** The unindented row an indented one hangs under, across blank rows, or null when it is not indented. */
function messageHead(rows: readonly string[], index: number, first: number): number | null {
  if (!/^\s/u.test(rows[index] ?? '')) return null
  for (let above = index - 1; above >= first; above--) {
    const row = rows[above] ?? ''
    if (row.trim().length > 0 && !/^\s/u.test(row)) return above
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

/** The mark an agent opens each message with. */
const LEADING_BULLET = /^[•⏺●][ \t]*/u

/** Opens Claude's recap of a turn. */
const RECAP_GLYPH = '※'

/** A row whose indented rows below belong to it and are chrome too: a recap, or a composer. */
const CHROME_HEAD = /^(?:※|[❯›](?:\s|$))/u

/** Codex's composer glyph: from here on the line is the composer drawn over the output, never output. */
const COMPOSER_GLYPH = '›'

function tidy(line: string): string {
  const output = line.split(COMPOSER_GLYPH, 1)[0] ?? ''
  return output.replace(/\s+/g, ' ').trim().replace(LEADING_SPINNER, '').replace(LEADING_BULLET, '')
}

/** Two box-drawing or block characters: a TUI's frame or rule, whatever is drawn over the rest of it. */
const FRAME = /^[\u2500-\u259f]{2}/u

/** A composer's line: what sits there was typed or suggested, not printed. */
const COMPOSER_LINE = /^[❯›] /u

/** The status lines agents draw around their output: modes, key hints, context left, how long a turn took. */
const AGENT_FOOTERS = [
  /\(shift\+tab to cycle\)/iu,
  /\? for shortcuts/u,
  /\besc to interrupt\b/iu,
  /\b\d+% context left\b/iu,
  /⏎ send/u,
  /\(disable recaps in \/config\)/u,
  /^✻ \p{L}+ for \d/u
]

/** The asides the app writes around a restored pane's record (see `scrollbackRecord.ts`); not the program's output. */
const OWN_MARK = /^\[(?:record — up to |end of record — |resume refused — |no conversation to resume — )/

/** A line with nothing to act on: a bare prompt, a frame, an agent's footer or composer, a spinner frame, the app's own mark. */
function isUninformative(line: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(line)) return true
  if (FRAME.test(line) || COMPOSER_LINE.test(line) || AGENT_FOOTERS.some((footer) => footer.test(line))) return true
  return OWN_MARK.test(line) || line.startsWith(RECAP_GLYPH) || isBarePrompt(line)
}

function isBarePrompt(line: string): boolean {
  const glyph = line[line.length - 1] as string
  if (!PROMPT_GLYPHS.includes(glyph)) return false

  const head = line.slice(0, -1)
  // "45%" and "step 3 >" end in a prompt glyph too, so these two only read as a
  // prompt after whitespace or punctuation; "$" sits directly against a bash path.
  if (AMBIGUOUS_GLYPHS.includes(glyph) && /[\p{L}\p{N}]$/u.test(head)) return false
  // A prompt is a location, not a sentence; two words covers "[user@host dir]#" plus a virtualenv prefix.
  const words = head.trim().split(/\s+/).filter(Boolean)
  // "coverage: 100 %" is a label and a number, which no prompt is.
  if (AMBIGUOUS_GLYPHS.includes(glyph) && words.some((word) => /^[\d.,]+$|:$/u.test(word))) return false
  return words.length <= 2
}

function truncate(line: string, maxChars: number): string {
  return line.length <= maxChars ? line : `${line.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}
