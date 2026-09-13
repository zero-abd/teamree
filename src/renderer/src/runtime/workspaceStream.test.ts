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
    // Two identical watches against a runtime that never answers. One is closed;
    // the other is not, and it is what makes the observation afterwards mean
    // something.
    //
    // The delay has to be pinned by a ceiling, not just a base. Backoff doubles,
    // so with only `retryBaseMs: 1` the pending delay by the time the first wait
    // releases is already tens of milliseconds and still growing — a fixed sleep
    // after `close()` is then a race against that delay rather than a look at
    // whether anything was cancelled, and it is won or lost by which poll of
    // `vi.waitFor` happened to release. A ceiling of 2ms keeps every pending
    // retry two milliseconds away for as long as the watch is retrying.
    const offline = (count: () => void) => (): Promise<never> => {
      count()
      return Promise.reject(new Error('offline'))
    }
    let closedAttempts = 0
    let liveAttempts = 0
    const retry = { onError: () => {}, retryBaseMs: 1, retryCeilingMs: 2 }

    const watch = watchWorkspace(() => {}, { ...retry, open: offline(() => (closedAttempts += 1)) })
    const control = watchWorkspace(() => {}, { ...retry, open: offline(() => (liveAttempts += 1)) })

    await vi.waitFor(() => expect(closedAttempts).toBeGreaterThan(1))
    await watch.close()
    const settled = closedAttempts
    const controlAtClose = liveAttempts

    // The window is measured in the control's retries rather than in
    // milliseconds: whatever this machine's speed, ten more attempts on a watch
    // that is still open is ten chances the closed one had to retry too.
    await vi.waitFor(() => expect(liveAttempts).toBeGreaterThan(controlAtClose + 10))
    expect(closedAttempts).toBe(settled)
    await control.close()
  })
})
