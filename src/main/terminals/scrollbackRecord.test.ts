import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Terminal as Emulator } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { evidenceLine } from '../../shared/outputEvidence'
import { screenRows } from './screenRows'
import { markerText, markerTime } from '../../shared/paneMarker'
import {
  closingMark,
  failedResumeMark,
  noConversationMark,
  INERT_RECORD,
  lastLines,
  NEW_SHELL_BELOW,
  NOT_RUN_AGAIN_BELOW,
  RECORD_LINE_BYTES,
  replayableRecord,
  RUN_AGAIN_BELOW,
  sanitizeRecordedOutput,
  tailFromLineBoundary,
  upgradedMarks
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
  const at = new Date(2026, 2, 4, 9, 5).getTime()

  it('closes the record with one marker line and no bracketed sentence', () => {
    const framed = replayableRecord({ text: 'built in 4.2s\r\n', recordedAt: at })
    expect(framed.startsWith('built in 4.2s')).toBe(true)
    expect(framed).toContain(markerText(`Restored · ${markerTime(at)}`))
    expect(framed.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/\[|end of record|nothing running|below/)
  })

  it('names what follows a record run again in place', () => {
    const framed = replayableRecord({ text: 'x\r\n', recordedAt: at }, NEW_SHELL_BELOW)
    expect(framed).toContain(markerText(`New shell · ${markerTime(at)}`))
    expect(closingMark(RUN_AGAIN_BELOW, at)).toContain(markerText(`Restarted · ${markerTime(at)}`))
  })

  // The pane's own end block says a stopped or not-rerun pane came back; a second marker would repeat it.
  it('leaves the record unmarked when the pane waits for its buttons', () => {
    expect(replayableRecord({ text: 'x\r\n', recordedAt: at }, NOT_RUN_AGAIN_BELOW)).toBe('x\r\n')
  })

  it('resets the colour on both sides of a marker', () => {
    // A record that ended mid-colour must not paint the mark, or the shell.
    expect(closingMark().startsWith(`${ESC}[0m`)).toBe(true)
    expect(closingMark().endsWith(`${ESC}[0m\r\n`)).toBe(true)
  })

  it('says a refused resume and a missing conversation as markers', () => {
    for (const mark of [failedResumeMark(1, true), noConversationMark('claude')]) {
      const line = mark.replace(/\x1b\[[0-9;]*m/g, '').trim()
      expect(line).toMatch(/^── .+ ──$/)
      expect(line).not.toMatch(/[[\]]/)
    }
    expect(failedResumeMark(1, true)).toContain('Resume refused · exit 1 · New session')
    expect(failedResumeMark(1, false)).toContain('Resume refused · exit 1 ──')
  })
})

// Profiles upgraded from 0.7.x showed their bracketed lines raw, in the pane and in `terminal read`.
describe('a record written by 0.3 to 0.7', () => {
  const DIM = `${ESC}[38;5;244m`
  const RESET = `${ESC}[0m`
  const old = (text: string): string => `${RESET}\r\n${DIM}[${text}]${RESET}\r\n`
  const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

  it('reads each bracketed line as the marker line saying it now, or drops it', () => {
    const cases: [string, string | null][] = [
      ['record — up to 2026-09-20 14:02, nothing running', null],
      ['end of record — not run again', null],
      ['end of record — new shell below', 'New shell'],
      ['end of record — resume attempt below', 'Restored'],
      ['end of record — npm run dev starts again below', 'Restarted'],
      ['resume refused — agent exited 1, record above; fresh agent below', 'Resume refused · exit 1 · New session'],
      ['resume refused — agent exited 2; open a new pane for a fresh one', 'Resume refused · exit 2'],
      ['no conversation to resume — fresh claude below', 'Nothing to resume · fresh claude'],
      ['task done — agent stopped, task not re-sent', 'Task done · not resumed']
    ]
    for (const [text, label] of cases) {
      const upgraded = plain(upgradedMarks(`before\r\n${old(text)}after\r\n`))
      expect(upgraded, text).not.toContain('[')
      if (label === null) expect(upgraded, text).toBe('before\r\n\r\nafter\r\n')
      else expect(upgraded, text).toBe(`before\r\n\r\n${markerText(label)}\r\nafter\r\n`)
    }
  })

  // The upgrade case: 0.7.3 ended the record with it, the rc added its own, and the end block now says it.
  it('drops the stopped notes at the very end, where the end block says it', () => {
    const rc = `${RESET}\r\n${DIM}${markerText('Task done · not resumed')}${RESET}\r\n`
    expect(plain(upgradedMarks(`> ${old('task done — agent stopped, task not re-sent')}${rc}`))).toMatch(/^> (\r\n)+$/)
    // Mid-record, it is the boundary the fresh session below it has.
    const mid = plain(upgradedMarks(`> ${old('task done — agent stopped, task not re-sent')}hello\r\n`))
    expect(mid).toContain(markerText('Task done · not resumed'))
  })

  it('leaves output that only looks like one alone', () => {
    const text = 'see [note — this is the agent talking]\r\n[task done — agent stopped, task not re-sent] and more\r\n'
    expect(upgradedMarks(text)).toBe(text)
  })

  it('is what a restored pane shows and what a read returns', () => {
    const text = upgradedMarks(`ok\r\n${old('task done — agent stopped, task not re-sent')}`)
    const upgraded = replayableRecord({ text, recordedAt: 0 })
    expect(plain(upgraded)).not.toMatch(/\[|agent stopped/)
  })
})

describe('the marks, as a sidebar row quotes a restored pane', () => {
  // The row's subtitle is the last real line, never the app's own aside.
  it('are never the line a row quotes', () => {
    const replayed = replayableRecord({ text: 'server listening on :3000\r\n', recordedAt: 0 })
    expect(evidenceLine(`${replayed}user@host login-flow % `)).toBe('server listening on :3000')
    expect(evidenceLine(`${failedResumeMark(1, false)}${noConversationMark('claude')}`)).toBeNull()
  })
})

describe('lastLines', () => {
  it('keeps the last lines, a final newline starting none', () => {
    expect(lastLines('a\r\nb\r\nc\r\n', 2)).toBe('b\r\nc\r\n')
    expect(lastLines('a\nb\nc', 2)).toBe('b\nc')
    expect(lastLines('a\nb\n', 5)).toBe('a\nb\n')
    expect(lastLines('\n\n\nx', 2)).toBe('\nx')
    expect(lastLines('', 3)).toBe('')
  })

  it('cuts lines past their allowance at a line boundary', () => {
    const long = `${'x'.repeat(RECORD_LINE_BYTES * 4)}\n`
    expect(lastLines(`${long}${long}short\n`, 3)).toBe('short\n')
  })
})
