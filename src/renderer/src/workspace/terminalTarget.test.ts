// Where a terminal started from the empty state goes.
//
// The button is one press and the decision behind it is the whole of what
// anybody could disagree with, so it is tested here rather than through the
// component: a shell opened in a checkout that does not exist yet fails in a
// way that reads as the button being broken.

import { describe, expect, it } from 'vitest'
import type { Worktree } from '@shared/entities'
import { terminalTarget } from './terminalTarget'

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 1,
  ...overrides
})

describe('which worktree a terminal opens in', () => {
  it('has nowhere to go when there is no worktree at all', () => {
    expect(terminalTarget([], [])).toBeNull()
  })

  it('takes the newest when nothing says otherwise', () => {
    const old = worktree({ id: 'w1', createdAt: 1 })
    const recent = worktree({ id: 'w2', createdAt: 9 })
    // Given in the wrong order on purpose: the runtime's list is not promised
    // to be sorted, and "newest" is the claim being made.
    expect(terminalTarget([recent, old], [])?.id).toBe('w2')
  })

  // Closing every tab tidies the window; it does not abandon the work.
  it('prefers the tab that was open last to the newest worktree', () => {
    const first = worktree({ id: 'w1', createdAt: 1 })
    const second = worktree({ id: 'w2', createdAt: 9 })
    expect(terminalTarget([first, second], ['w1'])?.id).toBe('w1')
  })

  it('takes the last of several remembered tabs', () => {
    const first = worktree({ id: 'w1', createdAt: 9 })
    const second = worktree({ id: 'w2', createdAt: 1 })
    expect(terminalTarget([first, second], ['w1', 'w2'])?.id).toBe('w2')
  })

  it('falls through a remembered tab that is no longer here', () => {
    const here = worktree({ id: 'w2', createdAt: 1 })
    expect(terminalTarget([here], ['gone'])?.id).toBe('w2')
  })

  // One still being checked out has no directory for a shell; one that failed
  // has nothing at all.
  it('refuses a worktree that is not ready, however recent or remembered', () => {
    const creating = worktree({ id: 'w1', state: 'creating', createdAt: 9 })
    const failed = worktree({ id: 'w2', state: 'failed', createdAt: 8 })
    expect(terminalTarget([creating, failed], ['w1'])).toBeNull()
    const ready = worktree({ id: 'w3', createdAt: 1 })
    expect(terminalTarget([creating, failed, ready], ['w1'])?.id).toBe('w3')
  })
})
