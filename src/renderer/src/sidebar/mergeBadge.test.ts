import { describe, expect, it } from 'vitest'
import type { WorktreeMergePreview } from '@shared/entities'
import { mergeBadge } from './mergeBadge'

function preview(overrides: Partial<WorktreeMergePreview> = {}): WorktreeMergePreview {
  return {
    worktreeId: 'wt',
    baseRef: 'origin/main',
    state: 'clean',
    conflicts: [],
    readAt: 0,
    ...overrides
  }
}

describe('mergeBadge', () => {
  it('says nothing at all before anything has been read', () => {
    // A row that guesses is worse than a row that waits; the answer lands a
    // moment later on its own.
    expect(mergeBadge(undefined)).toBeNull()
  })

  it('names the base ref it would merge into', () => {
    const badge = mergeBadge(preview())
    expect(badge?.label).toBe('merges')
    expect(badge?.tone).toBe('clean')
    expect(badge?.detail).toContain('origin/main')
  })

  it('counts the conflicts, and agrees with itself about the plural', () => {
    expect(mergeBadge(preview({ state: 'conflicts', conflicts: ['a.ts'] }))?.label).toBe('1 conflict')
    expect(mergeBadge(preview({ state: 'conflicts', conflicts: ['a.ts', 'b.ts'] }))?.label).toBe('2 conflicts')
  })

  it('lists the conflicting paths, up to a point', () => {
    const conflicts = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    const detail = mergeBadge(preview({ state: 'conflicts', conflicts }))?.detail ?? ''

    expect(detail).toContain('a.ts')
    expect(detail).toContain('e.ts')
    // A tooltip is not a file list.
    expect(detail).not.toContain('f.ts')
    expect(detail).toContain('and 2 more')
  })

  // The distinction the whole badge exists for: these two must never read as
  // "nothing wrong", because that is the opposite of what they mean.
  it('keeps "could not tell" visibly apart from "nothing conflicts"', () => {
    for (const state of ['unrelated', 'unavailable'] as const) {
      const badge = mergeBadge(preview({ state, reason: 'a specific reason' }))
      expect(badge?.label, state).toBe('unknown')
      expect(badge?.tone, state).toBe('unknown')
      expect(badge?.detail, state).toBe('a specific reason')
    }
  })

  it('still explains itself when no reason came back', () => {
    const badge = mergeBadge(preview({ state: 'unavailable' }))
    expect(badge?.detail).toContain('origin/main')
  })
})
