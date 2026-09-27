import { describe, expect, it } from 'vitest'
import type { WorktreeLog } from '@shared/entities'
import { directoryOf, emptyChangesLabel, fileNameOf } from './ChangesTab'
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
    expect(emptyChangesLabel(log({ commits: [commit] }))).toBe('All committed')
    expect(emptyChangesLabel(log({}))).toBe('No changes')
  })

  // The screen an agent leaves behind the moment it commits. Claiming nothing
  // happened, when the base could not be compared against at all, is the app
  // telling somebody their day's work is gone.
  it('does not claim nothing happened when the commits could not be read', () => {
    const text = emptyChangesLabel(log({ unavailable: 'base ref "origin/main" does not resolve' }))

    expect(text).not.toContain('Nothing changed')
    expect(text).toBe('Nothing uncommitted')
  })
})

// What `lineKind` used to decide here — which part of a diff a line belongs
// to — is now one of the things `parsePatch` decides, in `src/shared/patch.ts`,
// where the same pass also works out the line's number on each side. Its tests
// went with it, including the `---`/`+++` trap they were written for.

describe('splitting a path for display', () => {
  it('keeps the folder and the name apart, so the name can read first', () => {
    expect(directoryOf('src/search/rankResults.ts')).toBe('src/search')
    expect(fileNameOf('src/search/rankResults.ts')).toBe('rankResults.ts')
  })

  it('handles a file at the root', () => {
    expect(directoryOf('README.md')).toBe('')
    expect(fileNameOf('README.md')).toBe('README.md')
  })
})

describe('changedCount', () => {
  it('counts everything a commit would have to deal with', () => {
    expect(changedCount({ staged: 2, unstaged: 4, untracked: 1, conflicted: 2 })).toBe(9)
  })

  // Ahead and behind describe the branch, not the tree, so they belong to the
  // status bar rather than to this badge.
  it('is zero for a clean worktree, however far the branch has drifted', () => {
    expect(changedCount({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })).toBe(0)
  })

  it('is zero when the status has not been read yet', () => {
    expect(changedCount(undefined)).toBe(0)
  })
})
