import { describe, expect, it } from 'vitest'
import type { WorktreeStatus } from '@shared/entities'
import { statusStaleness, STATUS_UNCONFIRMED_AFTER_MS } from './statusStaleness'

const status = (readAt: number): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'task',
  ahead: 3,
  behind: 0,
  staged: 0,
  unstaged: 2,
  untracked: 0,
  conflicted: 0,
  readAt
})

describe('statusStaleness', () => {
  const now = 10 * 60_000

  // The common case by a wide margin: a workspace nobody is touching. Reads
  // only happen when something moves, so an hour-old status is ordinary — and
  // a badge on every row would be indistinguishable from no badge at all.
  it('says nothing about numbers that are merely old', () => {
    expect(statusStaleness({ status: status(0), unreadableSince: undefined, now })).toBeNull()
  })

  // A checkout busy under somebody's own git command, or a read that lost a
  // race with a removal. It comes back on its own a moment later.
  it('lets a passing failure go by unremarked', () => {
    const failing = { status: status(now - 5_000), unreadableSince: now - 1_000, now }

    expect(statusStaleness(failing)).toBeNull()
  })

  it('marks a worktree that has stopped answering, and says how far behind the numbers are', () => {
    const result = statusStaleness({
      status: status(now - 12 * 60_000),
      unreadableSince: now - STATUS_UNCONFIRMED_AFTER_MS,
      now
    })

    expect(result?.age).toBe('12m')
    expect(result?.detail).toContain('Could not read this worktree')
    expect(result?.detail).toContain('12m ago')
  })

  // The same judgement the pane rows make about silence: round down, so the
  // app never flatters how recently it last knew something.
  it('rounds the age down rather than up', () => {
    const result = statusStaleness({
      status: status(now - (119 * 1000 + 900)),
      unreadableSince: now - 60_000,
      now
    })

    expect(result?.age).toBe('1m')
  })

  // A row with no status has nothing on it to qualify; silence is already the
  // honest answer there.
  it('stays quiet when there is nothing on screen to disown', () => {
    expect(statusStaleness({ status: undefined, unreadableSince: 0, now })).toBeNull()
  })
})
