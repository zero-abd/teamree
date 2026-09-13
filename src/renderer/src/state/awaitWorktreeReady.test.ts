import { describe, expect, it } from 'vitest'
import type { Worktree } from '@shared/entities'
import { awaitWorktreeReady, WorktreeNotReady, WorktreeReadyTimeout } from './awaitWorktreeReady'

const worktree = (state: Worktree['state'], error?: string): Worktree => ({
  id: 'wt_1',
  projectId: 'proj_1',
  name: 'rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/tmp/atlas/.worktrees/rewrite-the-pager',
  startedFrom: 'origin/main',
  state,
  createdAt: Date.now(),
  ...(error ? { error } : {})
})

/** A runtime that only moves when something tells it to, as the real one does. */
function fakeRuntime(initial: Worktree) {
  let current = initial
  let reads = 0
  const watchers = new Set<() => void>()
  return {
    get reads() {
      return reads
    },
    read: async (): Promise<Worktree> => {
      reads += 1
      return current
    },
    watch: (onChange: () => void) => {
      watchers.add(onChange)
      return {
        close: () => {
          watchers.delete(onChange)
        }
      }
    },
    get watcherCount() {
      return watchers.size
    },
    /** Stands in for the runtime finishing the job and announcing it. */
    settle: (next: Worktree): void => {
      current = next
      for (const watcher of [...watchers]) watcher()
    }
  }
}

describe('awaitWorktreeReady', () => {
  it('returns at once for a worktree that is already ready', async () => {
    const runtime = fakeRuntime(worktree('ready'))
    await expect(
      awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    ).resolves.toMatchObject({ state: 'ready' })
    expect(runtime.watcherCount).toBe(0)
  })

  it('resolves on the change stream, not on a timer', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    // Nothing has changed yet, so nothing may resolve: a wait that came back
    // here would hand an agent a checkout that does not exist.
    expect(await Promise.race([waiting, Promise.resolve('still creating')])).toBe('still creating')

    runtime.settle(worktree('ready'))
    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
    expect(runtime.watcherCount).toBe(0)
  })

  it('rejects with the reason creation failed', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    runtime.settle(worktree('failed', "fatal: invalid reference 'origin/trunk'"))
    await expect(waiting).rejects.toThrow(WorktreeNotReady)
    await expect(waiting).rejects.toThrow("fatal: invalid reference 'origin/trunk'")
    expect(runtime.watcherCount).toBe(0)
  })

  it('ignores events that do not concern this worktree', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    runtime.settle(worktree('creating'))
    runtime.settle(worktree('creating'))
    runtime.settle(worktree('ready'))
    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
  })

  // The one race that would hang the composer forever: a worktree settles while
  // a read that started too early is still travelling. Nothing more is announced
  // afterwards, so that stale answer must not be the last word.
  it('re-reads when the worktree settles mid-read', async () => {
    let current = worktree('creating')
    const answering: Array<() => void> = []
    const watchers = new Set<() => void>()

    const read = (): Promise<Worktree> =>
      new Promise((resolve) => {
        // Captured at call time, as a real request's answer would be.
        const captured = current
        answering.push(() => resolve(captured))
      })

    const answerOne = async (): Promise<void> => {
      answering.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const waiting = awaitWorktreeReady({
      worktreeId: 'wt_1',
      read,
      watch: (onChange) => {
        watchers.add(onChange)
        return {
          close: () => {
            watchers.delete(onChange)
          }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await answerOne()

    current = worktree('ready')
    for (const watcher of [...watchers]) watcher()
    // Answers the read that was already in flight, which still says "creating".
    await answerOne()
    await answerOne()

    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
    expect(watchers.size).toBe(0)
  })

  it('gives up rather than leaving a subscription alive for the session', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({
      worktreeId: 'wt_1',
      read: runtime.read,
      watch: runtime.watch,
      timeoutMs: 5
    })
    await expect(waiting).rejects.toThrow(WorktreeReadyTimeout)
    expect(runtime.watcherCount).toBe(0)
  })
})
