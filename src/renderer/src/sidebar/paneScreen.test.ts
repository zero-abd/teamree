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

const recorded = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, '../../../main/terminals/fixtures', name), 'utf8')

describe('screenEvidence', () => {
  // The rows once quoted `3. No, and tell Claude…` and `policies to load.`
  it.each([
    ['claude-trust.txt', 'claude', 'Trust this folder?'],
    ['codex-trust.txt', 'codex', 'Trust this directory?'],
    ['claude-permission.txt', 'claude', 'Allow command: mkdir -p out && touch out/hello.txt?']
  ] as const)('quotes the question %s asks', async (name, agent, question) => {
    const screen = await replayScreen(recorded(name), 100, 30)
    expect(screenEvidence(screen, { agent })).toBe(question)
  })

  it('reads the question of an agent run from a shell', async () => {
    const screen = await replayScreen(recorded('codex-trust.txt'), 100, 30)
    expect(screenEvidence(screen, { foregroundAgent: 'codex' })).toBe('Trust this directory?')
  })

  // Composed from the approval layout codex draws; not recorded.
  it('quotes the command a codex approval is for', async () => {
    const approval = [
      '  Would you like to run the following command?',
      '',
      '  $ git push origin main',
      '',
      '› 1. Yes, proceed (y)',
      '  3. No, and tell Codex what to do differently (esc)',
      '',
      '  Press enter to confirm or esc to cancel'
    ].join('\r\n')
    const screen = await replayScreen(`\x1b[?1049h\x1b[H${approval}`, 100, 30)
    expect(screenEvidence(screen, { agent: 'codex' })).toBe('Allow command: git push origin main?')
  })

  // Composed from `06-claude-permission.png`, whose claude drew no key hint under the options.
  it('quotes an edit permission’s question with the key hint gone', async () => {
    const edit = [
      ' Edit file',
      ' src/math.ts',
      '   7 +export function sub(a: number, b: number): number {',
      '   8 +  return a - b',
      '   9 +}',
      '',
      ' Do you want to make this edit to math.ts?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No, and tell Claude what to do differently (esc)'
    ]
    for (const rows of [edit, [...edit, '', ' Esc to cancel · Tab to amend']]) {
      const screen = await replayScreen(`\x1b[?1049h\x1b[H${rows.join('\r\n')}`, 100, 30)
      expect(screenEvidence(screen, { agent: 'claude' })).toBe('Do you want to make this edit to math.ts?')
    }
  })

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
