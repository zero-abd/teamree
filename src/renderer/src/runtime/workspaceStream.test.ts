import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceEvent } from '@shared/methods'
import type { Subscription } from './runtimeClient'
import { watchWorkspace } from './workspaceStream'

/** A stand-in for the transport's subscribe, with the stream under test control. */
function fakeStream(): {
  open: (onEvent: (event: WorkspaceEvent) => void) => Promise<Subscription>
  push: (event: WorkspaceEvent) => void
  opened: () => number
  closed: () => number
} {
  const sinks: Array<(event: WorkspaceEvent) => void> = []
  let closedCount = 0
  return {
    open: async (onEvent) => {
      sinks.push(onEvent)
      const id = `sub_${sinks.length}`
      return {
        id,
        close: async () => {
          closedCount += 1
        }
      }
    },
    push: (event) => {
      for (const sink of sinks) sink(event)
    },
    opened: () => sinks.length,
    closed: () => closedCount
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('watchWorkspace', () => {
  it('delivers events until it is closed', async () => {
    const stream = fakeStream()
    const seen: WorkspaceEvent[] = []
    const watch = watchWorkspace((event) => seen.push(event), { open: stream.open })
    await flush()

    stream.push({ type: 'worktrees' })
    await watch.close()
    stream.push({ type: 'projects' })

    expect(seen).toEqual([{ type: 'worktrees' }])
    expect(stream.closed()).toBe(1)
  })

  it('retries until the runtime answers, then stops retrying', async () => {
    const stream = fakeStream()
    let attempts = 0
    const open = (onEvent: (event: WorkspaceEvent) => void): Promise<Subscription> => {
      attempts += 1
      if (attempts < 3) return Promise.reject(new Error('runtime is not up yet'))
      return stream.open(onEvent)
    }
    const onError = vi.fn()

    const seen: WorkspaceEvent[] = []
    const watch = watchWorkspace((event) => seen.push(event), {
      open,
      onError,
      retryBaseMs: 1,
      retryCeilingMs: 2
    })

    await vi.waitFor(() => expect(stream.opened()).toBe(1))
    stream.push({ type: 'terminals' })
    expect(seen).toEqual([{ type: 'terminals' }])
    expect(onError).toHaveBeenCalledTimes(2)

    await watch.close()
    expect(attempts).toBe(3)
  })

  it('closes a subscription that arrived after the watch was closed', async () => {
    const stream = fakeStream()
    let release = (): void => {}
    const open = (onEvent: (event: WorkspaceEvent) => void): Promise<Subscription> =>
      new Promise((resolve) => {
        release = () => resolve(stream.open(onEvent))
      })

    const seen: WorkspaceEvent[] = []
    const watch = watchWorkspace((event) => seen.push(event), { open })
    await watch.close()
    release()
    await vi.waitFor(() => expect(stream.closed()).toBe(1))

    stream.push({ type: 'projects' })
    expect(seen).toEqual([])
  })

  it('is safe to close twice', async () => {
    const stream = fakeStream()
    const watch = watchWorkspace(() => {}, { open: stream.open })
    await flush()

    await watch.close()
    await watch.close()
    expect(stream.closed()).toBe(1)
  })

  it('stops retrying once closed', async () => {
    let attempts = 0
    const watch = watchWorkspace(() => {}, {
      open: () => {
        attempts += 1
        return Promise.reject(new Error('offline'))
      },
      onError: () => {},
      retryBaseMs: 1
    })

    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1))
    await watch.close()
    const settled = attempts
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(settled)
  })
})
