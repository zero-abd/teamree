// A terminal's scrollback as text a script can read.
//
// `terminal read` hands back exactly what the pty produced, which is what a
// caller writing bytes back into a terminal needs and what anybody grepping it
// does not: a zsh prompt alone carries half a dozen SGR sequences, an OSC title,
// a bracketed-paste marker and a carriage return that rewrites the line, so the
// line reading `exit` arrives as `^[[?2004he^Hexit^[[?2004l^M`.
//
// So the bytes are replayed the way a terminal would apply them — escape
// sequences consumed, carriage returns and backspaces moving a cursor over a
// line buffer, erase-line clearing around it — and what is left is what the
// screen would have shown.
//
// `outputEvidence.replayLines` in src/shared does something adjacent and is
// deliberately not reused: it answers "which single line of this is worth
// putting on a sidebar row", so it collapses every tab to one space and leaves
// the payload of a DCS or APC sequence as text, neither of which matters for a
// one-line summary and both of which would show up in a transcript. Widening it
// would change what the sidebar and the notifications say; this is its own
// question, asked where its only caller is.

const ESC = '\x1b'
const BEL = '\x07'
const DEL = '\x7f'
/** 8-bit C1 forms of CSI, OSC and the string-introducers, which a pty may emit. */
const CSI_8BIT = '\u009b'
const OSC_8BIT = '\u009d'
const ST_8BIT = '\u009c'
const STRING_8BIT = '\u0090\u0098\u009e\u009f'

/** Columns between tab stops, which is every terminal's default. */
const TAB_WIDTH = 8

/**
 * The visible text of a raw terminal stream.
 *
 * Every escape sequence is consumed and dropped: CSI (including the private
 * `?`-parameter modes bracketed paste uses), OSC with any of its three
 * terminators, the string sequences DCS/SOS/PM/APC, the single shifts SS2 and
 * SS3, and every remaining two-character escape. Of the CSI sequences, the four
 * that change what a line *holds* rather than how it looks are honoured —
 * erase-line and the three horizontal cursor moves.
 *
 * Cursor addressing between rows is deliberately not emulated. A program that
 * moves around the grid is drawing a picture, and a half-emulated grid produces
 * confident nonsense; a full-screen program's output is better read raw.
 *
 * Trailing whitespace goes from every line, because a prompt redrawn over a
 * longer one leaves the tail of the longer one behind as spaces.
 */
export function plainText(raw: string): string {
  const lines: string[] = []
  let line = ''
  let cursor = 0

  const write = (text: string): void => {
    if (cursor > line.length) line = line.padEnd(cursor, ' ')
    line = line.slice(0, cursor) + text + line.slice(cursor + text.length)
    cursor += text.length
  }

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string

    if (char === ESC || char === CSI_8BIT || char === OSC_8BIT || STRING_8BIT.includes(char)) {
      const sequence = readEscape(raw, index)
      index = sequence.end
      if (sequence.final === 'K') {
        if (sequence.params === '' || sequence.params === '0') line = line.slice(0, cursor)
        else if (sequence.params === '1') line = ' '.repeat(Math.min(cursor, line.length)) + line.slice(cursor)
        else if (sequence.params === '2') line = ''
      } else if (sequence.final === 'C') cursor += count(sequence.params)
      else if (sequence.final === 'D') cursor = Math.max(0, cursor - count(sequence.params))
      else if (sequence.final === 'G') cursor = Math.max(0, count(sequence.params) - 1)
      continue
    }

    switch (char) {
      case '\n':
        lines.push(line.trimEnd())
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
        write(' '.repeat(TAB_WIDTH - (cursor % TAB_WIDTH)))
        break
      default:
        // The rest of C0 and DEL are signalling rather than text: a bell must
        // not become a glyph in the middle of a line.
        if (char >= ' ' && char !== DEL) write(char)
        break
    }
  }

  lines.push(line.trimEnd())
  return lines.join('\n')
}

/** One escape sequence: where it ends, and — for a CSI — what it asked for. */
type EscapeSequence = { end: number; final?: string; params?: string }

/**
 * Consumes the escape sequence starting at `start` and reports where it ends.
 *
 * A sequence the tail cut in half ends at the end of the input, which is the
 * right answer for a snapshot: the bytes that would have completed it are on
 * the far side of a boundary this caller never saw.
 */
function readEscape(raw: string, start: number): EscapeSequence {
  const introducer = raw[start] as string
  // An 8-bit introducer is one character where the 7-bit form is two.
  const next = introducer === ESC ? raw[start + 1] : introducer
  const body = introducer === ESC ? start + 2 : start + 1
  if (next === undefined) return { end: start }

  if (next === '[' || next === CSI_8BIT) {
    let index = body
    let params = ''
    // CSI runs through parameter and intermediate bytes to a final byte in
    // 0x40..0x7e.
    while (index < raw.length) {
      const char = raw[index] as string
      if (char >= '\x40' && char <= '\x7e') return { end: index, final: char, params }
      params += char
      index += 1
    }
    return { end: raw.length }
  }

  // OSC and the string sequences — DCS, SOS, PM, APC — differ only in what
  // their payload means, and none of it is text the screen showed.
  if (
    next === ']' ||
    next === OSC_8BIT ||
    next === 'P' ||
    next === 'X' ||
    next === '^' ||
    next === '_' ||
    STRING_8BIT.includes(next)
  ) {
    let index = body
    while (index < raw.length) {
      const char = raw[index] as string
      if (char === BEL || char === ST_8BIT) return { end: index }
      if (char === ESC && raw[index + 1] === '\\') return { end: index + 1 }
      index += 1
    }
    return { end: raw.length }
  }

  // SS2 and SS3 shift the single character after them into another set; the
  // character is part of the sequence, not of the line.
  if (next === 'N' || next === 'O') return { end: Math.min(body, raw.length - 1) }

  // An intermediate byte means more of them may follow before the final one:
  // `ESC ( B`, which selects the ASCII character set, is three bytes and losing
  // the last of them puts a stray `B` in front of the line.
  if (next >= '\x20' && next <= '\x2f') {
    let index = body
    while (index < raw.length) {
      const char = raw[index] as string
      if (char >= '\x30' && char <= '\x7e') return { end: index }
      index += 1
    }
    return { end: raw.length }
  }

  // Every other two-character escape: keypad modes, ESC 7/8.
  return { end: body - 1 }
}

/** A cursor move's repeat count; an omitted parameter means one. */
function count(params: string | undefined): number {
  const parsed = Number.parseInt(params ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}
