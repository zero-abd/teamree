import { describe, expect, it } from 'vitest'
import {
  clockLabel,
  closingMark,
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

  // The sequences that make an emulator transmit. Live, each of these was an
  // answer to a program that asked; replayed, the answer would be typed into a
  // shell that never asked anything — bytes on somebody's command line, out of
  // a file, at launch.
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
    // A record must not be able to clear the pane it was replayed into, switch
    // it to the alternate screen — which would hide everything printed after
    // it — or reset the emulator out from under the shell.
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
})

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
    expect(framed).toContain('nothing in it is running')
    expect(framed).toContain('a new shell starts below')
    expect(framed).toContain('built in 4.2s')
    // The output is between the two marks, which is what makes the second one
    // the boundary: whatever the new shell prints lands under it.
    expect(framed.indexOf('nothing in it is running')).toBeLessThan(framed.indexOf('built in 4.2s'))
    expect(framed.indexOf('built in 4.2s')).toBeLessThan(framed.indexOf('a new shell starts below'))
  })

  it('dates the record, and resets the colour on both sides of itself', () => {
    const at = Date.parse('2026-03-04T09:05:00Z')
    expect(openingMark(at)).toContain(clockLabel(at))
    // The date is the moment the record was written down, not the moment the
    // pane stopped: a record checkpointed while its pane was still running ends
    // wherever the last checkpoint reached, and the mark has to say so rather
    // than promise the reader the whole of what the pane printed.
    expect(openingMark(at)).toContain('up to')
    expect(openingMark(at)).toContain('last written down')
    expect(clockLabel(at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    // A record that ended mid-colour must not paint the mark, or the shell.
    expect(openingMark(at).startsWith(`${ESC}[0m`)).toBe(true)
    expect(closingMark().startsWith(`${ESC}[0m`)).toBe(true)
    expect(closingMark().endsWith(`${ESC}[0m\r\n`)).toBe(true)
  })
})
