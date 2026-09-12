import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceEvent } from '@shared/methods'
import {
  createLocalEditFence,
  createWorkspaceRefresher,
  isEmptyRefresh,
  mergeTargets,
  NOTHING_TO_REFRESH,
  refreshTargets,
  targetsForEvent,
  type RefreshTargets
} from './workspaceRefresh'

/** Runs batches immediately, so tests drive the queue with `flush` alone. */
const immediately = (run: () => void): (() => void) => {
  run()
  return () => {}
}

/** Lets every already-queued promise callback run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('targetsForEvent', () => {
  it('maps each collection event to exactly its own collection', () => {
    expect(targetsForEvent({ type: 'projects' })).toEqual(refreshTargets({ projects: true }))
    expect(targetsForEvent({ type: 'worktrees' })).toEqual(refreshTargets({ worktrees: true }))
    expect(targetsForEvent({ type: 'terminals' })).toEqual(refreshTargets({ terminals: true }))
  })

  it('scopes a layout event to the worktree it names', () => {
    expect(targetsForEvent({ type: 'layout', worktreeId: 'wt_a' })).toEqual(refreshTargets({ layouts: ['wt_a'] }))
  })

  it('applies an exit from the event rather than refetching for it', () => {
    const targets = targetsForEvent({ type: 'terminalExited', terminalId: 'term_1', exitCode: 3 })
    expect(targets).toEqual(refreshTargets({ exits: [{ terminalId: 'term_1', exitCode: 3 }] }))
    expect(targets.terminals).toBe(false)
  })
})

describe('mergeTargets', () => {
  it('unions collections and de-duplicates worktree ids', () => {
    const merged = mergeTargets(
      refreshTargets({ worktrees: true, layouts: ['wt_a'] }),
      refreshTargets({ terminals: true, layouts: ['wt_a', 'wt_b'] })
    )
    expect(merged.worktrees).toBe(true)
    expect(merged.terminals).toBe(true)
    expect(merged.layouts).toEqual(['wt_a', 'wt_b'])
  })

  it('keeps one exit per terminal, taking the later code', () => {
    const merged = mergeTargets(
      refreshTargets({ exits: [{ terminalId: 'term_1', exitCode: 0 }] }),
      refreshTargets({ exits: [{ terminalId: 'term_1', exitCode: 9 }] })
    )
    expect(merged.exits).toEqual([{ terminalId: 'term_1', exitCode: 9 }])
  })

  it('recognises an empty batch', () => {
    expect(isEmptyRefresh(NOTHING_TO_REFRESH)).toBe(true)
    expect(isEmptyRefresh(refreshTargets({ layouts: ['wt_a'] }))).toBe(false)
  })
})

describe('createWorkspaceRefresher', () => {
  it('coalesces a burst of events into one run per collection', async () => {
    const runs: RefreshTargets[] = []
    const refresher = createWorkspaceRefresher({
      run: async (targets) => {
        runs.push(targets)
      },
      schedule: () => () => {}
    })

    const burst: WorkspaceEvent[] = [
      { type: 'worktrees' },
      { type: 'worktrees' },
      { type: 'terminals' },
      { type: 'layout', worktreeId: 'wt_a' },
      { type: 'layout', worktreeId: 'wt_a' }
    ]
    for (const event of burst) refresher.push(event)
    await refresher.flush()

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ worktrees: true, terminals: true, layouts: ['wt_a'] })
  })

  it('does not run at all when nothing happened', async () => {
    const run = vi.fn(async () => {})
    const refresher = createWorkspaceRefresher({ run, schedule: immediately })
    await refresher.flush()
    expect(run).not.toHaveBeenCalled()
  })

  it('a layout event for one worktree never refetches another', async () => {
    const runs: RefreshTargets[] = []
    const refresher = createWorkspaceRefresher({
      run: async (targets) => {
        runs.push(targets)
      },
      schedule: immediately
    })

    refresher.push({ type: 'layout', worktreeId: 'wt_a' })
    await refresher.flush()
    refresher.push({ type: 'layout', worktreeId: 'wt_b' })
    await refresher.flush()

    expect(runs.map((targets) => targets.layouts)).toEqual([['wt_a'], ['wt_b']])
    expect(runs.every((targets) => !targets.worktrees && !targets.terminals && !targets.projects)).toBe(true)
  })

  it('never lets two batches overlap, however fast the events arrive', async () => {
    let concurrent = 0
    let peak = 0
    const settle: Array<() => void> = []
    const refresher = createWorkspaceRefresher({
      run: async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise<void>((resolve) => settle.push(resolve))
        concurrent -= 1
      },
      schedule: immediately
    })

    refresher.push({ type: 'worktrees' })
    refresher.push({ type: 'worktrees' })
    refresher.push({ type: 'terminals' })
    // Let the first batch start, then keep pushing while it is still in flight.
    await tick()
    refresher.push({ type: 'projects' })
    expect(settle).toHaveLength(1)

    let idle = false
    const finished = refresher.flush().then(() => {
      idle = true
    })
    // `flush` must not start a second batch either; releasing one at a time is
    // the only way the queue can make progress.
    for (let guard = 0; guard < 20 && !idle; guard += 1) {
      expect(settle.length).toBeLessThanOrEqual(1)
      settle.shift()?.()
      await tick()
    }
    await finished
    expect(idle).toBe(true)
    expect(peak).toBe(1)
  })

  it('applies the newest answer last when an early refetch is slow', async () => {
    // The trap: the first `worktree.list` resolves after the second one. With
    // overlapping runs the stale list would be the one on screen.
    const applied: string[] = []
    const answers = [
      { label: 'stale', delayTicks: 6 },
      { label: 'fresh', delayTicks: 0 }
    ]
    let call = 0
    const refresher = createWorkspaceRefresher({
      run: async () => {
        const answer = answers[call++] ?? { label: `extra-${call}`, delayTicks: 0 }
        for (let tick = 0; tick < answer.delayTicks; tick += 1) await Promise.resolve()
        applied.push(answer.label)
      },
      schedule: immediately
    })

    refresher.push({ type: 'worktrees' })
    refresher.push({ type: 'worktrees' })
    await refresher.flush()

    expect(applied).toEqual(['stale', 'fresh'])
    expect(applied.at(-1)).toBe('fresh')
  })

  it('reports a failed batch and keeps serving later events', async () => {
    const onError = vi.fn()
    let attempt = 0
    const refresher = createWorkspaceRefresher({
      run: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('runtime went away')
      },
      onError,
      schedule: immediately
    })

    refresher.push({ type: 'worktrees' })
    await refresher.flush()
    refresher.push({ type: 'terminals' })
    await refresher.flush()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(attempt).toBe(2)
  })

  it('drops work that has not started when the watch stops', async () => {
    const run = vi.fn(async () => {})
    const refresher = createWorkspaceRefresher({ run, schedule: () => () => {} })
    refresher.push({ type: 'worktrees' })
    refresher.cancelPending()
    await refresher.flush()
    expect(run).not.toHaveBeenCalled()

    refresher.push({ type: 'projects' })
    await refresher.flush()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('createLocalEditFence', () => {
  it('rejects a read that started before a local edit', () => {
    const fence = createLocalEditFence()
    const token = fence.mark('wt_a')
    fence.bump('wt_a')
    expect(fence.isStale('wt_a', token)).toBe(true)
  })

  it('accepts a read when nothing was edited under it', () => {
    const fence = createLocalEditFence()
    fence.bump('wt_a')
    const token = fence.mark('wt_a')
    expect(fence.isStale('wt_a', token)).toBe(false)
  })

  it('fences each worktree separately', () => {
    const fence = createLocalEditFence()
    const token = fence.mark('wt_a')
    fence.bump('wt_b')
    expect(fence.isStale('wt_a', token)).toBe(false)
  })
})
