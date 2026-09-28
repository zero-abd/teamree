// Waiting for a checkout to exist, and for its setup to pass, before an agent is started inside it. Bridged
// on the change stream rather than by polling; the timeout is not a deadline for the worktree, only what
// stops one that never settles leaving a subscription and a promise alive.

import type { ClosedPane, Terminal, Worktree } from '@shared/entities'
import type { WorkspaceEvent } from '@shared/methods'

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
    super(`Worktree still being created after ${Math.round(timeoutMs / 1000)}s`)
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

/** Longer than any install worth waiting on; past it the agent is held, as after a failure. */
export const SETUP_TIMEOUT_MS = 60 * 60_000

/** `passed` also covers no setup at all; `closed` is a failed setup's pane closed without a pass. */
export type SetupOutcome = 'passed' | 'failed' | 'closed'

export type AwaitSetupOptions = {
  worktreeId: string
  read: (worktreeId: string) => Promise<Worktree>
  panes: (worktreeId: string) => Promise<Terminal[]>
  closed: (worktreeId: string) => Promise<ClosedPane[]>
  watch: (onEvent: (event: WorkspaceEvent) => void) => { close: () => void }
  /** It failed already: only a pass settles it now, and the pane gone means given up on. No deadline. */
  failed?: boolean
  timeoutMs?: number
}

/**
 * Resolves once a ready worktree's setup settles, so its agent starts after it and never beside it. A passed
 * setup's pane closes itself: its exit event, or the closed pane's record, tells a pass from a close.
 */
export async function awaitSetup(options: AwaitSetupOptions): Promise<SetupOutcome> {
  const { worktreeId, read, panes, closed, watch, failed = false } = options
  let setupId: string | undefined
  const outcome = async (): Promise<SetupOutcome | null> => {
    const worktree = await read(worktreeId)
    // A repository's command is still being asked about: Run opens a pane, Skip leaves none.
    if (worktree.setupAsk !== undefined) return null
    setupId = worktree.setupTerminalId
    if (setupId === undefined) return 'passed'
    const pane = (await panes(worktreeId)).find((terminal) => terminal.id === setupId)
    if (pane === undefined) {
      // The exit event waits out the stream's coalescing; a read can find the passed pane closed first.
      const gone = (await closed(worktreeId)).find((one) => one.terminalId === setupId)
      return gone?.exitCode === 0 || !failed ? 'passed' : 'closed'
    }
    if (pane.running) return null
    if (pane.exitCode === 0) return 'passed'
    return failed ? null : 'failed'
  }

  const first = await outcome()
  if (first !== null) return first

  return await new Promise<SetupOutcome>((resolve, reject) => {
    let done = false
    const finish = (settled: SetupOutcome | Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      subscription.close()
      if (settled instanceof Error) reject(settled)
      else resolve(settled)
    }
    // Serialised as in `awaitWorktreeReady`: an event landing mid-read is remembered, not dropped.
    let reading = false
    let missed = false
    const check = (): void => {
      if (done) return
      if (reading) {
        missed = true
        return
      }
      reading = true
      outcome()
        .then((settled) => {
          reading = false
          if (settled !== null) return finish(settled)
          if (!missed) return
          missed = false
          check()
        })
        .catch((error: unknown) => {
          reading = false
          finish(error instanceof Error ? error : new Error(String(error)))
        })
    }
    const timer = failed ? undefined : setTimeout(() => finish('failed'), options.timeoutMs ?? SETUP_TIMEOUT_MS)
    const subscription = watch((event) => {
      // Ahead of any read: by the time one looks, a passed setup's pane is closed.
      if (event.type === 'terminalExited' && event.terminalId === setupId) {
        if (event.exitCode === 0) return finish('passed')
        if (!failed) return finish('failed')
      }
      check()
    })
    check()
  })
}
