// Waiting for a checkout to exist before anything is started inside it. Bridged on the
// change stream rather than by polling; the timeout is not a deadline for the worktree,
// only what stops one that never settles leaving a subscription and a promise alive.

import type { Worktree } from '@shared/entities'

/** Long enough for a first checkout of a large repository on a slow disk; short enough that nothing leaks for the window's life. */
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

/** Resolves once the worktree is ready; rejects the moment creation fails, so no agent starts in a checkout that is not there. */
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

    // Reads are serialised: a burst of events would put several `worktree.get` answers in flight and
    // the oldest could arrive last. An event landing mid-read is remembered, not dropped: it may be
    // the one announcing the state this read was too early to see, and no further event is coming.
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
