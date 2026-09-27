import { describe, expect, it } from 'vitest'
import type { PeerLink, TeammatePresence, TeammateWorktree, TeamworkStatus } from '@shared/entities'
import type { WorktreeOverlap } from '@shared/tasks'
import { teammateRows } from './teammateRows'
import { activityWords, presenceWords, teamCues, teamGlance, theirOverlap } from './teamGlance'

const NOW = 1_700_000_000_000

const pane = (overrides = {}) => ({
  id: 'peer:bo:t_1',
  title: 'claude',
  shell: '/bin/zsh',
  agent: 'claude' as const,
  running: true,
  busy: true,
  quietForMs: 0,
  ...overrides
})

function theirs(overrides: Partial<TeammateWorktree> = {}): TeammateWorktree {
  return {
    id: 'peer:bo:wt_1',
    handle: 'bo',
    publicKey: 'bo-key',
    name: 'cart-totals',
    branch: 'cart-totals',
    state: 'ready',
    heardAt: NOW - 5_000,
    live: true,
    panes: [pane()],
    ...overrides
  }
}

const link = (handle: string, phase: PeerLink['phase']): PeerLink => ({
  publicKey: `${handle}-key`,
  handle,
  phase,
  since: NOW - 60_000,
  attempts: 1
})

const status = (links: PeerLink[]): TeamworkStatus => ({
  state: 'read',
  projectId: 'p1',
  relay: { url: 'ws://127.0.0.1:1/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true, url: '/srv/shop.git' },
  enrolled: true,
  links,
  readAt: NOW
})

const presence = (
  worktrees: TeammateWorktree[],
  teammates: { handle: string; connected: boolean; heardAt: number | null }[]
): TeammatePresence => ({
  state: 'read',
  projectId: 'p1',
  worktrees,
  teammates: teammates.map((teammate) => ({ ...teammate, publicKey: `${teammate.handle}-key` })),
  readAt: NOW
})

describe('teamGlance', () => {
  it('gives every teammate on the roster a face, in a stable order, with what their agents are doing', () => {
    const worktrees = [
      theirs(),
      theirs({ id: 'peer:bo:wt_2', name: 'retry-payment', panes: [pane({ id: 'peer:bo:t_2', asking: true })] })
    ]
    const glance = teamGlance(
      status([link('bo', 'connected'), link('ana', 'waiting')]),
      presence(worktrees, [
        { handle: 'bo', connected: true, heardAt: NOW - 5_000 },
        { handle: 'ana', connected: false, heardAt: null }
      ]),
      teammateRows(worktrees, NOW),
      NOW
    )
    expect(glance.map((teammate) => teammate.handle)).toEqual(['ana', 'bo'])
    const [ana, bo] = glance
    expect(ana).toMatchObject({ presence: 'unknown', heardAgoMs: null, asking: 0, working: 0, worktrees: [] })
    expect(bo).toMatchObject({ presence: 'online', asking: 1, working: 1 })
    expect(bo?.worktrees.map((worktree) => [worktree.name, worktree.tone])).toEqual([
      ['cart-totals', 'working'],
      ['retry-payment', 'waiting']
    ])
    // The row an asking cue takes you to.
    expect(bo?.askingPaneId).toBe('peer:bo:t_2')
  })

  it('calls a teammate away once their link is down, and says how long since they were heard', () => {
    const worktrees = [theirs({ live: false, heardAt: NOW - 36_000 })]
    const [bo] = teamGlance(
      status([link('bo', 'unreachable')]),
      presence(worktrees, [{ handle: 'bo', connected: false, heardAt: NOW - 36_000 }]),
      teammateRows(worktrees, NOW),
      NOW
    )
    expect(bo).toMatchObject({ presence: 'away', heardAgoMs: 36_000 })
    // An away teammate's remembered question is not a question anybody can answer now.
    expect(bo?.asking).toBe(0)
  })

  it('still draws a teammate whose rows arrived before the roster did', () => {
    const worktrees = [theirs()]
    const glance = teamGlance(undefined, presence(worktrees, []), teammateRows(worktrees, NOW), NOW)
    expect(glance.map((teammate) => [teammate.handle, teammate.presence])).toEqual([['bo', 'online']])
  })

  it('is empty with nobody on the team', () => {
    expect(teamGlance(status([]), presence([], []), [], NOW)).toEqual([])
    expect(teamGlance(undefined, undefined, [], NOW)).toEqual([])
  })
})

describe('the words for a teammate', () => {
  it('says presence in one or two words', () => {
    expect(presenceWords({ presence: 'online', heardAgoMs: 0 })).toBe('online')
    expect(presenceWords({ presence: 'away', heardAgoMs: 36_000 })).toBe('away')
    // The age of the picture, named as that: a teammate static for hours is not hours away.
    expect(presenceWords({ presence: 'away', heardAgoMs: 3 * 3_600_000 }, true)).toBe('away · picture 3h old')
    expect(presenceWords({ presence: 'unknown', heardAgoMs: null })).toBe('not heard yet')
  })

  it('says what their agents are doing, asking first', () => {
    expect(activityWords({ asking: 1, working: 2, worktrees: [{}, {}] })).toBe('1 asking · 2 working')
    expect(activityWords({ asking: 0, working: 0, worktrees: [{}] })).toBe('1 worktree')
    expect(activityWords({ asking: 0, working: 0, worktrees: [] })).toBe('no worktrees')
  })
})

describe('teamCues', () => {
  it('names the one teammate asking, and counts them past one', () => {
    const one = teamCues([{ handle: 'bo', asking: 2, askingPaneId: 'p' }], 0)
    expect(one.asking).toEqual({ label: 'bo asking', count: 1, handle: 'bo', paneId: 'p' })
    const two = teamCues(
      [
        { handle: 'ana', asking: 1, askingPaneId: 'a' },
        { handle: 'bo', asking: 1, askingPaneId: 'b' }
      ],
      0
    )
    expect(two.asking).toEqual({ label: '2 teammates asking', count: 2, handle: 'ana', paneId: 'a' })
    expect(teamCues([{ handle: 'bo', asking: 0, askingPaneId: undefined }], 0).asking).toBeNull()
  })

  it('counts handoffs waiting for you', () => {
    expect(teamCues([], 1).handoffs).toEqual({ label: 'handoff', count: 1 })
    expect(teamCues([], 3).handoffs).toEqual({ label: '3 handoffs', count: 3 })
    expect(teamCues([], 0).handoffs).toBeNull()
  })
})

describe('theirOverlap', () => {
  const overlaps: WorktreeOverlap[] = [
    {
      worktreeId: 'mine-1',
      with: { handle: 'bo', worktreeId: 'peer:bo:wt_1' },
      paths: ['src/cart.js'],
      conflicts: []
    },
    {
      worktreeId: 'mine-2',
      with: { handle: 'bo', worktreeId: 'peer:bo:wt_1' },
      paths: ['src/a.js'],
      conflicts: ['src/a.js']
    },
    { worktreeId: 'mine-1', with: { worktreeId: 'mine-2' }, paths: ['src/cart.js'], conflicts: [] }
  ]

  it('says which of your worktrees touch the same files as theirs, conflicts first', () => {
    const named = (id: string): string => (id === 'mine-1' ? 'receipt-email' : 'refunds')
    expect(theirOverlap('peer:bo:wt_1', overlaps, named)).toEqual({
      tone: 'conflict',
      label: 'refunds +1',
      title: 'refunds · conflict: src/a.js\nreceipt-email · src/cart.js',
      worktreeId: 'mine-2'
    })
  })

  it('is null for a worktree nobody here overlaps', () => {
    expect(theirOverlap('peer:bo:wt_9', overlaps, () => '')).toBeNull()
    expect(theirOverlap('peer:bo:wt_1', undefined, () => '')).toBeNull()
  })
})
