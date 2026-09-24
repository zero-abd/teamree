import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evidenceLine } from '@shared/outputEvidence'
import { replayScreen, screenEvidence } from './paneScreen'

// A Claude pane after a restart, as `terminal read` returned it: the resumed agent redraws its
// transcript in the alternate screen, addressing each row by cursor movement. 43x39 is the pane's size.
const resumedClaude = readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-resumed.txt'), 'utf8')

describe('replayScreen', () => {
  it('follows the cursor between rows, as the pane did', async () => {
    const screen = await replayScreen('one\r\ntwo\x1b[1A\rONE', 20, 5)
    expect(screen).toEqual({ rows: ['ONE', 'two'], alternate: false })
  })

  it('joins a row the terminal wrapped back into one line', async () => {
    expect((await replayScreen('abcdefghijklmno', 10, 5)).rows).toEqual(['abcdefghijklmno'])
  })

  it('says when a program owns the alternate screen', async () => {
    expect(await replayScreen('\x1b[?1049h\x1b[3;1Hless', 20, 5)).toEqual({ rows: ['', '', 'less'], alternate: true })
  })
})

describe('screenEvidence', () => {
  it('quotes what a resumed Claude last said, where the stream replay found nothing', async () => {
    expect(evidenceLine(resumedClaude)).toBeNull()
    const screen = await replayScreen(resumedClaude, 43, 39)
    expect(screenEvidence(screen, { agent: 'claude' })).toBe('Added to calc.js:3:')
  })

  // A narrow pane wraps zsh's default prompt; the "%" after the first is its end-of-line mark.
  it('quotes nothing from a fresh zsh whose prompt wraps', async () => {
    const prompt = 'abd@Abdullahs-MacBook-Pro add-a-sub-function-to-claude % '
    const screen = await replayScreen(`${prompt}%\r\n${prompt}`, 52, 10)
    expect(screenEvidence(screen, {})).toBeNull()
  })

  it('quotes nothing from a shell’s pager or editor', async () => {
    const screen = await replayScreen('\x1b[?1049h\x1b[1;1Hcalc.js 3L, 60B', 20, 5)
    expect(screenEvidence(screen, {})).toBeNull()
  })
})
