// The rows in here are read off a pty running the real binary on 2026-09-23:
// when an agent changes what it draws under a question, this file should fail.

import { describe, expect, it } from 'vitest'
import { screenOpinion } from './screenOpinion'

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
