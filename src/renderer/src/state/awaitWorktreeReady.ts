// Waiting for a checkout to exist before anything is started inside it.
//
// A task is one action — create the worktree, then run the agent in it — but the
// two halves are seconds apart, because git has to fetch and check out first.
// The gap is bridged on the change stream rather than by polling: the runtime
// already says when a worktree moved, and a timer here would either be slower
// than that or busier than it needs to be.
//
// The timeout is not a deadline for the worktree, which keeps going and keeps
// reporting itself on its sidebar row. It exists so a worktree that never
// settles cannot leave a subscription and a promise alive for the rest of the
// session.

import type { Worktree } from '@shared/entities'

/**
 * Long enough that a first checkout of a large repository on a slow disk still
 * gets its agent, short enough that nothing leaks for the life of the window.
 */
export const WORKTREE_READY_TIMEOUT_MS = 10 * 60_000

export type AwaitWorktreeReadyOptions = {
  worktreeId: string
  read: (worktreeId: string) => Promise<Worktree>
  /** Calls back on every workspace change; returns the teardown. */
  watch: (onChange: () => void) => { close: () => void }
  timeoutMs?: number
}

export class WorktreeNotReady extends Error {
  constructor(readonly worktree: Worktree) {
    super(worktree.error ?? `The worktree stopped at "${worktree.state}".`)
    this.name = 'WorktreeNotReady'
  }
}

export class WorktreeReadyTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`The worktree was still being created ${Math.round(timeoutMs / 1000)}s later.`)
    this.name = 'WorktreeReadyTimeout'
  }
}

/**
 * Resolves with the worktree once it is ready, and rejects the moment creation
 * fails — so a caller never starts an agent in a checkout that is not there.
 */
export async function awaitWorktreeReady(options: AwaitWorktreeReadyOptions): Promise<Worktree> {
  const { worktreeId, read, watch } = options
  const timeoutMs = options.timeoutMs ?? WORKTREE_READY_TIMEOUT_MS

  const first = await read(worktreeId)
  if (first.state === 'ready') return first
  if (first.state !== 'creating') throw new WorktreeNotReady(first)

  return await new Promise<Worktree>((resolve, reject) => {
    let done = false
    const finish = (act: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      subscription.close()
      act()
    }

    // Reads are serialised: the stream is coarse, so a burst of events would
    // otherwise put several `worktree.get` answers in flight at once and the
    // oldest could arrive last. An event that lands mid-read is remembered
    // rather than dropped — it may be the one announcing the state this read
    // was already too early to see, and no further event is coming.
    let reading = false
    let missed = false
    const check = (): void => {
      if (done) return
      if (reading) {
        missed = true
        return
      }
      reading = true
      read(worktreeId)
        .then((worktree) => {
          reading = false
          if (worktree.state !== 'creating') {
            finish(() => (worktree.state === 'ready' ? resolve(worktree) : reject(new WorktreeNotReady(worktree))))
            return
          }
          if (!missed) return
          missed = false
          check()
        })
        .catch((error: unknown) => {
          reading = false
          finish(() => reject(error))
        })
    }

    const timer = setTimeout(() => finish(() => reject(new WorktreeReadyTimeout(timeoutMs))), timeoutMs)
    const subscription = watch(check)
    // The worktree may have become ready between the first read and the watch.
    check()
  })
}
