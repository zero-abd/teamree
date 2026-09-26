import { describe, expect, it } from 'vitest'
import type { PullRequestChecks, WorktreeLanding } from '@shared/entities'
import { AFTER_PUSH_MS, FOCUS_GAP_MS, focusRefresh, pollRefresh, type RefreshFacts } from './pullRequestRefresh'

const landing = (worktreeId: string, overrides: Partial<WorktreeLanding> = {}): WorktreeLanding => ({
  worktreeId,
  branch: worktreeId,
  base: 'main',
  host: 'github',
  published: true,
  unmerged: 1,
  merged: false,
  readAt: 0,
  ...overrides
})

const pending: PullRequestChecks = { passing: 0, failing: 0, pending: 1, list: [{ name: 'test', state: 'pending' }] }
const passing: PullRequestChecks = { passing: 1, failing: 0, pending: 0, list: [{ name: 'test', state: 'pass' }] }
const open = (checks = pending) => ({ number: 1, url: 'u', state: 'open' as const, checks })

function facts(overrides: Partial<RefreshFacts> = {}): RefreshFacts {
  return {
    worktrees: [
      { id: 'a', projectId: 'p' },
      { id: 'b', projectId: 'p' },
      { id: 'c', projectId: 'p' },
      { id: 'd', projectId: 'p' },
      { id: 'e', projectId: 'q' }
    ],
    projects: [{ id: 'p' }, { id: 'q', fetchInBackground: false }],
    landings: {
      a: landing('a', { pullRequest: open() }),
      b: landing('b', { pullRequest: open(passing) }),
      c: landing('c', { host: null }),
      d: landing('d', { merged: true, pullRequest: { number: 2, url: 'u', state: 'merged' } }),
      e: landing('e', { pullRequest: open() })
    },
    pushes: {},
    ...overrides
  }
}

describe('focusRefresh', () => {
  it('re-reads every published GitHub branch not yet merged, where background fetching is on', () => {
    expect(focusRefresh(facts(), 0, undefined)).toEqual(['a', 'b'])
  })

  it('waits between two focuses', () => {
    expect(focusRefresh(facts(), FOCUS_GAP_MS - 1, 0)).toEqual([])
    expect(focusRefresh(facts(), FOCUS_GAP_MS, 0)).toEqual(['a', 'b'])
  })
})

describe('pollRefresh', () => {
  it('re-reads only open pull requests with checks pending', () => {
    expect(pollRefresh(facts(), 0)).toEqual(['a'])
  })

  it('keeps reading a branch pushed a moment ago, whose new checks may not be reported yet', () => {
    const pushed = facts({ pushes: { b: { phase: 'pushed', at: 1000 } } })
    expect(pollRefresh(pushed, 1000 + AFTER_PUSH_MS - 1)).toEqual(['a', 'b'])
    expect(pollRefresh(pushed, 1000 + AFTER_PUSH_MS)).toEqual(['a'])
  })

  it('reads nothing for a project with background fetching off', () => {
    const off = facts({
      projects: [
        { id: 'p', fetchInBackground: false },
        { id: 'q', fetchInBackground: false }
      ]
    })
    expect(pollRefresh(off, 0)).toEqual([])
    expect(focusRefresh(off, 0, undefined)).toEqual([])
  })
})
