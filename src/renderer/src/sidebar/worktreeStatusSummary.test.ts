import { describe, expect, it } from 'vitest'
import type { WorktreeStatus } from '@shared/entities'
import { formatReadAge, summarizeWorktreeStatus } from './worktreeStatusSummary'

const status = (overrides: Partial<WorktreeStatus>): WorktreeStatus => ({
  worktreeId: 'wt',
  branch: 'task/thing',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})

describe('summarizeWorktreeStatus', () => {
  it('has nothing to say without a reading', () => {
    expect(summarizeWorktreeStatus(undefined)).toBeNull()
  })

  it('counts every kind of change as dirty', () => {
    const summary = summarizeWorktreeStatus(status({ staged: 1, unstaged: 2, untracked: 3 }))
    expect(summary?.dirty).toBe(6)
    expect(summary?.tone).toBe('dirty')
  })

  it('lets conflicts outrank ordinary dirt', () => {
    expect(summarizeWorktreeStatus(status({ unstaged: 4, conflicted: 1 }))?.tone).toBe('conflict')
  })

  it('says so when there is nothing to report', () => {
    const summary = summarizeWorktreeStatus(status({}))
    expect(summary?.tone).toBe('quiet')
    expect(summary?.description).toBe('clean, in sync')
  })

  it('describes divergence in reading order', () => {
    expect(summarizeWorktreeStatus(status({ ahead: 2, behind: 3, unstaged: 1 }))?.description).toBe(
      '2 ahead · 3 behind · 1 uncommitted'
    )
  })
})

describe('formatReadAge', () => {
  it('scales the unit to the age', () => {
    expect(formatReadAge(1000, 1000)).toBe('just now')
    expect(formatReadAge(0, 30_000)).toBe('30s ago')
    expect(formatReadAge(0, 600_000)).toBe('10m ago')
    expect(formatReadAge(0, 7_200_000)).toBe('2h ago')
  })

  it('never reports a negative age from a clock skew', () => {
    expect(formatReadAge(5000, 0)).toBe('just now')
  })
})
