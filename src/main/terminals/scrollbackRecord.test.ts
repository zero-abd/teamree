import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Terminal as Emulator } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { evidenceLine } from '../../shared/outputEvidence'
import { screenRows } from './screenRows'
import {
  clockLabel,
  closingMark,
  failedResumeMark,
  noConversationMark,
  INERT_RECORD,
  openingMark,
  replayableRecord,
  sanitizeRecordedOutput,
  tailFromLineBoundary
} from './scrollbackRecord'

const ESC = '\x1b'

describe('sanitizeRecordedOutput', () => {
  it('keeps the text, the whitespace and the colour', () => {
    const output = `${ESC}[31mfailed\t3 tests${ESC}[0m\r\n  at line 4\n`
    expect(sanitizeRecordedOutput(output)).toBe(output)
  })

  it('keeps a progress line exactly as it overwrote itself', () => {
    const output = '  0% |          |\r 50% |=====     |\r100% |==========|\r\n'
    expect(sanitizeRecordedOutput(output)).toBe(output)
  })

  // Replayed, each answer would be typed into a shell that never asked.
  it('drops everything that would make the terminal send bytes back', () => {
    const asking = [
      `${ESC}[6n`, // cursor position report
      `${ESC}[c`, // device attributes
      `${ESC}[>0c`, // secondary device attributes
      `${ESC}[?1004h`, // focus reporting: the terminal then reports focus itself
      `${ESC}[?1000h`, // mouse reporting: every click becomes input
      `${ESC}[?2004h`, // bracketed paste
      '\x05', // ENQ, whose answerback some terminals still honour
      '\x9b6n' // the same request, spelled with the eight-bit introducer
    ]
    for (const sequence of asking) {
      expect(sanitizeRecordedOutput(`before${sequence}after`), sequence).toBe('beforeafter')
    }
  })

  it('drops everything that reaches outside the pane', () => {
    const reaching = [
      `${ESC}]0;a new window title\x07`, // OSC 0: renames the window
      `${ESC}]52;c;ZXZpbA==\x07`, // OSC 52: writes the system clipboard
      `${ESC}]8;;https://example.invalid\x07link${ESC}]8;;\x07`, // OSC 8: a URL under the text
      `${ESC}]9;a notification\x1b\\`, // OSC 9: a desktop notification
      `${ESC}P+q544f\x1b\\`, // DCS: a terminfo query
      `${ESC}_Ga=T,f=100;payload\x1b\\` // APC: an image protocol
    ]
    for (const sequence of reaching) {
      const kept = sanitizeRecordedOutput(`before${sequence}after`)
      expect(kept, sequence).not.toContain('evil')
      expect(kept, sequence).toMatch(INERT_RECORD)
      expect(kept.startsWith('before'), sequence).toBe(true)
      expect(kept.endsWith('after'), sequence).toBe(true)
    }
  })

  it('drops the sequences that would rewrite what is already on screen', () => {
    // Clear, alternate screen, reset, home, charset: none may reach the pane.
    for (const sequence of [`${ESC}[2J`, `${ESC}[?1049h`, `${ESC}c`, `${ESC}[H`, `${ESC}(0`]) {
      expect(sanitizeRecordedOutput(`before${sequence}after`), sequence).toBe('beforeafter')
    }
  })

  it('refuses an SGR wearing private parameters, and a sequence with no end', () => {
    expect(sanitizeRecordedOutput(`${ESC}[?31m`)).toBe('')
    expect(sanitizeRecordedOutput(`text${ESC}[31`)).toBe('text')
    expect(sanitizeRecordedOutput(`text${ESC}]0;half a title`)).toBe('text')
  })

  it('leaves nothing that can act, whatever it is given', () => {
    const hostile =
      `${ESC}[6n${ESC}]52;c;ZXZpbA==\x07${ESC}c\x07\x05${ESC}[?1049h` +
      `real output\n${ESC}[32mgreen${ESC}[0m\x9b6n${ESC}_apc\x1b\\`
    const kept = sanitizeRecordedOutput(hostile)
    expect(kept).toMatch(INERT_RECORD)
    expect(kept).toContain('real output')
    expect(kept).toContain(`${ESC}[32m`)
  })

  // Claude places every word with a column move (`ESC[8G`) instead of a space.
  it('keeps the spaces an agent laid out by moving the cursor forward', async () => {
    const recorded = fixture('claude-trust.txt')
    const kept = sanitizeRecordedOutput(recorded)
    expect(kept).toMatch(INERT_RECORD)
    const live = await screenRows(recorded, 100, 30)
    const replayed = await screenRows(kept, 100, 30)
    for (const line of PROSE) {
      expect(live).toContain(line)
      expect(replayed).toContain(line)
    }
    expect(sanitizeRecordedOutput(`a${ESC}[3Cb${ESC}[8Gc`)).toBe('a   b  c')
  })

  it('pads only forward, and not to a far-right probe', () => {
    expect(sanitizeRecordedOutput(`abcdef${ESC}[2Gx`)).toBe('abcdefx')
    expect(sanitizeRecordedOutput(`a${ESC}[999Cb`)).toBe('ab')
    expect(sanitizeRecordedOutput(`a${ESC}[999Gb`)).toBe('ab')
  })

  it('keeps every space through a narrower and a wider window', async () => {
    for (const output of [fixture('claude-trust.txt'), sanitizeRecordedOutput(fixture('claude-trust.txt'))]) {
      const rows = await rowsAfterResizes(output, [60, 160])
      for (const line of PROSE) expect(rows).toContain(line)
    }
  })
})

/** Lines of `claude-trust.txt` as the live emulator draws them at 100 columns. */
const PROSE = [
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  " Claude Code'll be able to read, edit, and execute files here.",
  '   Yes, I trust this folder'
]

const fixture = (name: string): string => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')

/** Every buffer row after writing `output` at 100 columns and resizing through `widths`. */
async function rowsAfterResizes(output: string, widths: number[]): Promise<string[]> {
  const term = new Emulator({ cols: 100, rows: 30, scrollback: 100 })
  try {
    await new Promise<void>((resolve) => term.write(output, resolve))
    for (const cols of widths) {
      term.resize(cols, 30)
      await new Promise<void>((resolve) => term.write('', resolve))
    }
    const buffer = term.buffer.active
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
  } finally {
    term.dispose()
  }
}

describe('tailFromLineBoundary', () => {
  it('returns the whole of a record that fits', () => {
    expect(tailFromLineBoundary('short\n', 64)).toBe('short\n')
  })

  it('keeps the end rather than the beginning', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}\n`).join('')
    const tail = tailFromLineBoundary(lines, 100)

    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(100)
    expect(tail.endsWith('line 199\n')).toBe(true)
    expect(tail).not.toContain('line 0\n')
  })

  it('starts on a line, so a cut cannot leave half an escape sequence', () => {
    const text = `one\n${ESC}[31mtwo${ESC}[0m\nthree\n`
    // A cap that lands inside the colour sequence on the second line.
    const tail = tailFromLineBoundary(text, 18)
    expect(tail).toBe('three\n')
    expect(tail).toMatch(INERT_RECORD)
  })

  it('does not cut inside a character', () => {
    const tail = tailFromLineBoundary('€€€€', 7)
    expect(tail).toBe('€€')
  })
})

describe('the marks around a record', () => {
  it('says what the output is, and where this session starts', () => {
    const framed = replayableRecord({ text: 'built in 4.2s\r\n', recordedAt: Date.parse('2026-03-04T09:05:00Z') })

    expect(framed).toContain('record')
    expect(framed).toContain('nothing running')
    expect(framed).toContain('new shell below')
    expect(framed).toContain('built in 4.2s')
    expect(framed.indexOf('nothing running')).toBeLessThan(framed.indexOf('built in 4.2s'))
    expect(framed.indexOf('built in 4.2s')).toBeLessThan(framed.indexOf('new shell below'))
  })

  it('dates the record, and resets the colour on both sides of itself', () => {
    const at = Date.parse('2026-03-04T09:05:00Z')
    expect(openingMark(at)).toContain(clockLabel(at))
    // The date is when the record was written down, not when the pane stopped.
    expect(openingMark(at)).toContain('up to')
    expect(openingMark(at)).toContain('nothing running')
    expect(clockLabel(at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    // A record that ended mid-colour must not paint the mark, or the shell.
    expect(openingMark(at).startsWith(`${ESC}[0m`)).toBe(true)
    expect(closingMark().startsWith(`${ESC}[0m`)).toBe(true)
    expect(closingMark().endsWith(`${ESC}[0m\r\n`)).toBe(true)
  })
})

describe('the marks, as a sidebar row quotes a restored pane', () => {
  // The row's subtitle is the last real line, never the app's own aside.
  it('are never the line a row quotes', () => {
    const replayed = replayableRecord({ text: 'server listening on :3000\r\n', recordedAt: 0 })
    expect(evidenceLine(`${replayed}user@host login-flow % `)).toBe('server listening on :3000')
    expect(evidenceLine(`${failedResumeMark(1, true, false)}${noConversationMark('claude')}`)).toBeNull()
  })
})
