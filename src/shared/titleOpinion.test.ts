// The titles in here are transcripts. Each one was read off a pty running the
// real binary on 2026-09-23, and the reason they are quoted verbatim rather
// than paraphrased is that the table is only worth anything while it still
// matches what the binaries write: when an agent changes its title, this is the
// file that should fail.

import { describe, expect, it } from 'vitest'
import { TITLE_RULES, titleOpinion } from './titleOpinion'

describe('reading a claude title', () => {
  it('reads the rotating circle as a turn in progress', () => {
    expect(titleOpinion('claude', '◐ Date command')).toBe('working')
    expect(titleOpinion('claude', '◑ Pineapple')).toBe('working')
    expect(titleOpinion('claude', '◒ Claude Code')).toBe('working')
    expect(titleOpinion('claude', '◓ Claude Code')).toBe('working')
  })

  // The whole reason the bell exists as a second source. Claude Code writes the
  // same star while it is blocked on its own permission prompt as it writes
  // when the turn is finished, so this title cannot separate them and must not
  // pretend to.
  it('has no opinion about the star, which it writes both when asking and when done', () => {
    expect(titleOpinion('claude', '✳ Bash tool sw_vers productVersion')).toBeNull()
    expect(titleOpinion('claude', '✳ Claude Code')).toBeNull()
  })
})

describe('reading a codex title', () => {
  it('reads a braille frame in front of the directory as a turn in progress', () => {
    expect(titleOpinion('codex', '⠏ teamree')).toBe('working')
    expect(titleOpinion('codex', '⠋ teamree')).toBe('working')
    expect(titleOpinion('codex', '⠸ teamree')).toBe('working')
  })

  it('has no opinion about the bare directory name codex writes the rest of the time', () => {
    expect(titleOpinion('codex', 'teamree')).toBeNull()
  })
})

describe('what the table does not claim', () => {
  it('says nothing about a pane running no agent, whatever its title looks like', () => {
    expect(titleOpinion(undefined, '◐ Date command')).toBeNull()
    expect(titleOpinion(undefined, '⠏ teamree')).toBeNull()
  })

  it('says nothing about an agent no row was written for', () => {
    expect(titleOpinion('gemini', '◐ anything')).toBeNull()
    expect(titleOpinion('droid', '⠏ anything')).toBeNull()
    expect(titleOpinion('opencode', '⠏ anything')).toBeNull()
  })

  // One agent's glyph is not another's: the rows are keyed by the binary that
  // was watched writing them, and a title shape carries no meaning on its own.
  it('does not lend one agent another agent’s glyph', () => {
    expect(titleOpinion('codex', '◐ Date command')).toBeNull()
    expect(titleOpinion('claude', '⠏ teamree')).toBeNull()
  })

  it('reads only a prefix, so a summary that mentions a glyph is still just a summary', () => {
    expect(titleOpinion('claude', 'Fix the ◐ spinner')).toBeNull()
    expect(titleOpinion('claude', '◐Date command')).toBeNull()
    expect(titleOpinion('codex', 'draw ⠏ frames')).toBeNull()
  })

  it('has no opinion about an empty title', () => {
    expect(titleOpinion('claude', '')).toBeNull()
    expect(titleOpinion('codex', '')).toBeNull()
  })
})

describe('the table itself', () => {
  // A row claiming `waiting` would be a claim that some agent says so in its
  // title. None was found to, and this is what should fail when one is added
  // without the observation being written into the header comment beside it.
  it('claims only that agents say when they are working, never that they say they are waiting', () => {
    expect(TITLE_RULES.map((rule) => rule.says)).toEqual(['working', 'working'])
  })

  it('anchors every pattern, so no row can match in the middle of somebody’s summary', () => {
    for (const rule of TITLE_RULES) expect(rule.matches.source.startsWith('^')).toBe(true)
  })
})
