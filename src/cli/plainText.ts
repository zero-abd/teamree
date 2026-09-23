// A terminal's scrollback replayed the way a terminal would apply it, so a
// script can grep it. `outputEvidence.replayLines` is deliberately not reused:
// it collapses tabs and keeps DCS/APC payloads, which suits a sidebar row, not a transcript.

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
 * The visible text of a raw terminal stream: every escape consumed, erase-line and
 * the horizontal cursor moves honoured. Row addressing is not emulated: a
 * half-emulated grid produces confident nonsense. Trailing spaces from redrawn prompts are trimmed.
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
        // The rest of C0 and DEL are signalling, not text.
        if (char >= ' ' && char !== DEL) write(char)
        break
    }
  }

  lines.push(line.trimEnd())
  return lines.join('\n')
}

/** One escape sequence: where it ends, and — for a CSI — what it asked for. */
type EscapeSequence = { end: number; final?: string; params?: string }

// Consumes the escape at `start`; one the tail cut in half ends at the end of the input.
function readEscape(raw: string, start: number): EscapeSequence {
  const introducer = raw[start] as string
  // An 8-bit introducer is one character where the 7-bit form is two.
  const next = introducer === ESC ? raw[start + 1] : introducer
  const body = introducer === ESC ? start + 2 : start + 1
  if (next === undefined) return { end: start }

  if (next === '[' || next === CSI_8BIT) {
    let index = body
    let params = ''
    // CSI runs through parameter and intermediate bytes to a final byte in 0x40..0x7e.
    while (index < raw.length) {
      const char = raw[index] as string
      if (char >= '\x40' && char <= '\x7e') return { end: index, final: char, params }
      params += char
      index += 1
    }
    return { end: raw.length }
  }

  // OSC and the string sequences (DCS, SOS, PM, APC): none of the payload is text the screen showed.
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

  // SS2 and SS3: the character after them is part of the sequence, not the line.
  if (next === 'N' || next === 'O') return { end: Math.min(body, raw.length - 1) }

  // Intermediate bytes may precede the final: `ESC ( B` is three bytes, and
  // losing the last puts a stray `B` in front of the line.
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
