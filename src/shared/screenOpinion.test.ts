// The rows in here are read off a pty running the real binary on 2026-09-23:
// when an agent changes what it draws under a question, this file should fail.

import { describe, expect, it } from 'vitest'
import { screenOpinion, screenQuestion } from './screenOpinion'

const claudeTrust = [
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel'
]

const codexTrust = ['› 1. Yes, continue', '  2. No, quit', '', '  Press enter to continue']

describe('reading the bottom of an agent screen', () => {
  it('reads each harness hint under a question as asking', () => {
    expect(screenOpinion('claude', claudeTrust)).toBe('waiting')
    expect(
      screenOpinion('claude', [
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   4. No',
        '',
        ' Esc to cancel · Tab to amend'
      ])
    ).toBe('waiting')
    expect(screenOpinion('codex', codexTrust)).toBe('waiting')
    expect(screenOpinion('codex', ['› 1. Yes, proceed (y)', '', '  Press enter to confirm or esc to cancel   '])).toBe(
      'waiting'
    )
  })

  it('has no opinion about a shell printing the same words', () => {
    expect(screenOpinion(undefined, claudeTrust)).toBeNull()
  })

  it("reads one harness's hint only for that harness", () => {
    expect(screenOpinion('codex', claudeTrust)).toBeNull()
    expect(screenOpinion('gemini', codexTrust)).toBeNull()
  })

  it('has no opinion once the words have scrolled up behind a composer', () => {
    const answered = [...claudeTrust, '', '────', '❯ ', '────', '  ⏸ manual mode on']
    expect(screenOpinion('claude', answered)).toBeNull()
  })

  it('does not read the hint quoted inside a line', () => {
    expect(screenOpinion('claude', ['⏺ It said: Enter to confirm · Esc to cancel', '❯ '])).toBeNull()
  })
})

// A row, the board and a notification say what is being asked, never an answer or a key hint.
describe('reading the question an agent is asking', () => {
  const claudeEdit = [
    '────────────────────────────────',
    ' Edit file',
    ' math.ts',
    '   1  export const add = (a, b) => a + b',
    '',
    ' Do you want to make this edit to math.ts?',
    ' ❯ 1. Yes',
    '   2. Yes, allow all edits during this session (shift+tab)',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend'
  ]

  // Composed from the approval layout codex draws (title, `$ ` command, options, hint); not recorded.
  const codexApproval = [
    '  Would you like to run the following command?',
    '',
    '  $ touch out/hello.txt',
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for this command (a)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel'
  ]

  it('quotes the question above the options', () => {
    expect(screenQuestion('claude', claudeEdit)).toBe('Do you want to make this edit to math.ts?')
  })

  it('names a folder trust prompt in two words', () => {
    expect(screenQuestion('claude', [' Accessing workspace:', '', ' /repo', ...claudeTrust])).toBe('Trust this folder?')
    expect(
      screenQuestion('codex', [
        '  Do you trust the contents of this directory? Working with untrusted contents comes with higher',
        '  policies to load.',
        '',
        ...codexTrust
      ])
    ).toBe('Trust this directory?')
  })

  it('names the command a codex approval is for', () => {
    expect(screenQuestion('codex', codexApproval)).toBe('Allow command: touch out/hello.txt?')
  })

  it('names the command a claude permission is for', () => {
    expect(
      screenQuestion('claude', [
        ' Bash command',
        ' Tip: auto mode handles these prompts for you',
        '',
        '   mkdir -p out',
        '   Create out directory',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        '',
        ' Esc to cancel · Tab to amend'
      ])
    ).toBe('Allow command: mkdir -p out?')
  })

  it('never answers with an option or a key hint', () => {
    expect(screenQuestion('claude', claudeTrust)).toBeNull()
    expect(screenQuestion('codex', codexTrust)).toBeNull()
  })

  it('asks nothing when the screen does not read as asking', () => {
    expect(screenQuestion('claude', [...claudeEdit, '', '────', '❯ ', '────', '  ⏸ manual mode on'])).toBeNull()
    expect(screenQuestion(undefined, claudeEdit)).toBeNull()
  })
})
