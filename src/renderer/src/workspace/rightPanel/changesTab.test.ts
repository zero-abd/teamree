import { describe, expect, it } from 'vitest'
import type { WorktreeLog } from '@shared/entities'
import { directoryOf, draftFor, emptyChangesLabel, fileNameOf, withDraft } from './ChangesTab'
import { changedCount } from './RightRail'

describe('emptyChangesLabel', () => {
  const log = (partial: Partial<WorktreeLog>): WorktreeLog => ({
    worktreeId: 'wt',
    baseRef: 'origin/main',
    commits: [],
    truncated: false,
    readAt: 0,
    ...partial
  })

  const commit = {
    sha: 'abc1234',
    shortSha: 'abc1234',
    author: 'Ada',
    committedAt: '2026-01-01T00:00:00Z',
    subject: 'the work'
  }

  it('separates a worktree that has committed from one that has not', () => {
    expect(emptyChangesLabel(log({ commits: [commit] }))).toBe('Everything here is committed.')
    expect(emptyChangesLabel(log({}))).toBe('Nothing changed here yet.')
  })

  // The screen an agent leaves behind the moment it commits. Claiming nothing
  // happened, when the base could not be compared against at all, is the app
  // telling somebody their day's work is gone.
  it('does not claim nothing happened when the commits could not be read', () => {
    const text = emptyChangesLabel(log({ unavailable: 'base ref "origin/main" does not resolve' }))

    expect(text).not.toContain('Nothing changed')
    expect(text).toBe('Nothing uncommitted here.')
  })
})

// What `lineKind` used to decide here — which part of a diff a line belongs
// to — is now one of the things `parsePatch` decides, in `src/shared/patch.ts`,
// where the same pass also works out the line's number on each side. Its tests
// went with it, including the `---`/`+++` trap they were written for.

describe('splitting a path for display', () => {
  it('keeps the directory and the name apart, so the name can stay put', () => {
    expect(directoryOf('src/search/rankResults.ts')).toBe('src/search/')
    expect(fileNameOf('src/search/rankResults.ts')).toBe('rankResults.ts')
  })

  it('handles a file at the root', () => {
    expect(directoryOf('README.md')).toBe('')
    expect(fileNameOf('README.md')).toBe('README.md')
  })
})

// A half-typed commit message is the one thing on this screen the app cannot
// reconstruct — the panel already refuses to clear it when a commit is refused.
// It belongs to the worktree it was typed for, and not to the panel, which is
// never remounted when the tabs change underneath it.
describe('commit message drafts', () => {
  it('keeps each worktree’s message to itself', () => {
    const drafts = withDraft({}, 'wt-a', 'fix the parser')

    expect(draftFor(drafts, 'wt-a')).toBe('fix the parser')
    expect(draftFor(drafts, 'wt-b')).toBe('')
  })

  // Discarding it on a tab switch would be the same loss by a kinder route:
  // going to read another worktree's diff is not abandoning the message.
  it('hands a message back when its worktree comes round again', () => {
    const drafts = withDraft(withDraft({}, 'wt-a', 'fix the parser'), 'wt-b', 'bump the relay')

    expect(draftFor(drafts, 'wt-a')).toBe('fix the parser')
    expect(draftFor(drafts, 'wt-b')).toBe('bump the relay')
  })

  it('has nothing to show before a worktree is chosen', () => {
    expect(draftFor(withDraft({}, 'wt-a', 'fix the parser'), null)).toBe('')
  })

  // What a landed commit empties, and only for the worktree it landed in.
  it('forgets a message that has been emptied, and leaves the rest', () => {
    const drafts = withDraft(withDraft({}, 'wt-a', 'fix the parser'), 'wt-b', 'bump the relay')
    const after = withDraft(drafts, 'wt-a', '')

    expect(after).toEqual({ 'wt-b': 'bump the relay' })
  })
})
