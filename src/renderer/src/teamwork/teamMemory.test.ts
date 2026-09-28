import { describe, expect, it } from 'vitest'
import type { TeammatePresence, TeammateWorktree } from '@shared/entities'
import { newTeamMemory, observeTeammates } from './teamMemory'

const NOW = 1_790_000_000_000

const worktree = (stage: TeammateWorktree['stage'], heardAt = NOW, ahead: number | null = 0): TeammateWorktree => ({
  id: 'peer:bo:wt_1',
  handle: 'bo',
  publicKey: 'BO',
  name: 'cart totals',
  branch: 'cart-totals',
  state: 'ready',
  heardAt,
  live: true,
  panes: [],
  ...(stage === undefined ? {} : { stage }),
  ...(ahead === null ? {} : { ahead })
})

const read = (worktrees: TeammateWorktree[], connected: boolean): Record<string, TeammatePresence> => ({
  p1: {
    state: 'read',
    projectId: 'p1',
    worktrees,
    teammates: [{ handle: 'bo', publicKey: 'BO', connected, heardAt: NOW - 1_000 }],
    readAt: NOW
  }
})

describe('what the window remembers about teammates between reads', () => {
  it('keeps the last moment a teammate was seen online, including the read that says they left', () => {
    const memory = newTeamMemory()
    observeTeammates(memory, {}, read([], true), NOW)
    expect(memory.lastOnline.get('BO')).toBe(NOW)
    observeTeammates(memory, read([], true), read([], false), NOW + 60_000)
    expect(memory.lastOnline.get('BO')).toBe(NOW + 60_000)
    observeTeammates(memory, read([], false), read([], false), NOW + 120_000)
    expect(memory.lastOnline.get('BO')).toBe(NOW + 60_000)
  })

  it('stamps a merge when it sees the stage move, at the snapshot that carried it', () => {
    const memory = newTeamMemory()
    observeTeammates(memory, read([worktree('working')], true), read([worktree('landed', NOW - 2_000)], true), NOW)
    expect(memory.landedAt.get('peer:bo:wt_1')).toBe(NOW - 2_000)
    // Later snapshots do not move it.
    observeTeammates(
      memory,
      read([worktree('landed')], true),
      read([worktree('landed', NOW + 9_000)], true),
      NOW + 9_000
    )
    expect(memory.landedAt.get('peer:bo:wt_1')).toBe(NOW - 2_000)
  })

  it('stamps a task that appears beside a picture it already had, and the read that says it finished', () => {
    const memory = newTeamMemory()
    const next = { ...worktree('working'), id: 'peer:bo:wt_2' }
    observeTeammates(memory, read([worktree('working')], true), read([worktree('working'), next], true), NOW)
    expect(memory.startedAt.get('peer:bo:wt_2')).toBe(NOW)
    expect(memory.startedAt.has('peer:bo:wt_1')).toBe(false)
    observeTeammates(
      memory,
      read([worktree('working')], true),
      read([worktree('failed', NOW + 5_000)], true),
      NOW + 5_000
    )
    expect(memory.finishedAt.get('peer:bo:wt_1')).toEqual({ at: NOW + 5_000, failed: true })
  })

  it('does not call the tasks in a teammate’s first picture started', () => {
    const memory = newTeamMemory()
    observeTeammates(memory, {}, read([worktree('working')], true), NOW)
    const unheard: Record<string, TeammatePresence> = {
      p1: {
        state: 'read',
        projectId: 'p1',
        worktrees: [],
        teammates: [{ handle: 'bo', publicKey: 'BO', connected: false, heardAt: null }],
        readAt: NOW
      }
    }
    observeTeammates(memory, unheard, read([worktree('done')], true), NOW)
    expect(memory.startedAt.size).toBe(0)
    expect(memory.finishedAt.size).toBe(0)
  })

  it('does not invent a time for a merge that happened before it was watching', () => {
    const memory = newTeamMemory()
    observeTeammates(memory, {}, read([worktree('landed')], true), NOW)
    expect(memory.landedAt.size).toBe(0)
    // A first snapshot carries no git details yet; the landed one after it is old news, not a merge.
    observeTeammates(memory, read([worktree(undefined, NOW, null)], true), read([worktree('landed')], true), NOW)
    expect(memory.landedAt.size).toBe(0)
  })
})
