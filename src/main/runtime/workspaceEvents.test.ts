import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceEvent } from '../../shared/methods'
import {
  createCoalescedStream,
  WorkspaceEventBus,
  WORKSPACE_EVENT_COALESCE_MS
} from './workspaceEvents'

/** A schedule the test advances by hand, so no assertion waits on a real clock. */
function manualClock(): { schedule: (run: () => void, ms: number) => () => void; tick: () => void; pending: () => number } {
  const runs: Array<{ run: () => void; cancelled: boolean }> = []
  return {
    schedule: (run) => {
      const entry = { run, cancelled: false }
      runs.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    tick: () => {
      for (const entry of runs.splice(0)) if (!entry.cancelled) entry.run()
    },
    pending: () => runs.filter((entry) => !entry.cancelled).length
  }
}

describe('workspace event bus', () => {
  it('delivers to every listener and stops on unsubscribe', () => {
    const bus = new WorkspaceEventBus()
    const first: WorkspaceEvent[] = []
    const second: WorkspaceEvent[] = []

    const off = bus.on((event) => first.push(event))
    bus.on((event) => second.push(event))
    bus.emit({ type: 'projects' })
    off()
    bus.emit({ type: 'worktrees' })

    expect(first).toEqual([{ type: 'projects' }])
    expect(second).toEqual([{ type: 'projects' }, { type: 'worktrees' }])
    expect(bus.listenerCount).toBe(1)
  })

  it('keeps publishing when one listener throws', () => {
    const bus = new WorkspaceEventBus()
    const survivor = vi.fn()
    bus.on(() => {
      throw new Error('subscriber is broken')
    })
    bus.on(survivor)

    expect(() => bus.emit({ type: 'terminals' })).not.toThrow()
    expect(survivor).toHaveBeenCalledWith({ type: 'terminals' })
  })
})

describe('coalescing', () => {
  it('collapses a burst on one collection into a single event', () => {
    const clock = manualClock()
    const delivered: WorkspaceEvent[] = []
    const stream = createCoalescedStream((event) => delivered.push(event), { schedule: clock.schedule })

    for (let index = 0; index < 25; index += 1) stream.push({ type: 'worktrees' })
    expect(delivered).toEqual([])

    clock.tick()
    expect(delivered).toEqual([{ type: 'worktrees' }])
  })

  it('keeps events for different collections and different ids apart', () => {
    const clock = manualClock()
    const delivered: WorkspaceEvent[] = []
    const stream = createCoalescedStream((event) => delivered.push(event), { schedule: clock.schedule })

    stream.push({ type: 'terminals' })
    stream.push({ type: 'layout', worktreeId: 'wt_a' })
    stream.push({ type: 'terminals' })
    stream.push({ type: 'layout', worktreeId: 'wt_b' })
    stream.push({ type: 'terminalExited', terminalId: 'term_1', exitCode: 7 })
    clock.tick()

    // First-seen order, one per key, newest payload.
    expect(delivered).toEqual([
      { type: 'terminals' },
      { type: 'layout', worktreeId: 'wt_a' },
      { type: 'layout', worktreeId: 'wt_b' },
      { type: 'terminalExited', terminalId: 'term_1', exitCode: 7 }
    ])
  })

  it('opens a new window for the next burst', () => {
    const clock = manualClock()
    const delivered: WorkspaceEvent[] = []
    const stream = createCoalescedStream((event) => delivered.push(event), { schedule: clock.schedule })

    stream.push({ type: 'projects' })
    clock.tick()
    stream.push({ type: 'projects' })
    clock.tick()

    expect(delivered).toEqual([{ type: 'projects' }, { type: 'projects' }])
  })

  it('drops pending events and its timer when cancelled', () => {
    const clock = manualClock()
    const delivered: WorkspaceEvent[] = []
    const stream = createCoalescedStream((event) => delivered.push(event), { schedule: clock.schedule })

    stream.push({ type: 'projects' })
    stream.cancel()
    clock.tick()

    expect(delivered).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('defaults to the named window rather than an ad hoc number', async () => {
    const delivered: WorkspaceEvent[] = []
    const stream = createCoalescedStream((event) => delivered.push(event))

    stream.push({ type: 'projects' })
    stream.push({ type: 'projects' })
    await new Promise((resolve) => setTimeout(resolve, WORKSPACE_EVENT_COALESCE_MS * 3))

    expect(delivered).toEqual([{ type: 'projects' }])
  })
})
