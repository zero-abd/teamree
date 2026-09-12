// Turning workspace events into refetches, without refetching more than the
// event asked for and without letting two refetches race.
//
// The stream is coarse by design: an event names a collection, the client
// re-reads it. That is only safe if the re-reads are ordered. Two overlapping
// `worktree.list` calls can resolve in either order, so the older answer can
// land last and put the UI back to a state the runtime has already left —
// permanently, because nothing else is coming to correct it. So every refetch
// goes through one queue here: at most one batch is ever in flight, and events
// that arrive during a batch accumulate into the next one. Ordering then holds
// by construction rather than by hope.
//
// The second half of the file is the other direction of the same race: a fetch
// that started before the user edited something locally must not land on top of
// that edit.

import type { WorkspaceEvent } from '@shared/methods'

/** What one batch of events says has to be re-read. */
export type RefreshTargets = {
  projects: boolean
  worktrees: boolean
  terminals: boolean
  /** Layouts of exactly these worktrees. Never widened to "every layout". */
  layouts: readonly string[]
  /** Git status of exactly these worktrees. */
  statuses: readonly string[]
  /** Exits are applied from the event itself; they need no call. */
  exits: readonly TerminalExit[]
}

export type TerminalExit = { terminalId: string; exitCode: number }

export const NOTHING_TO_REFRESH: RefreshTargets = {
  projects: false,
  worktrees: false,
  terminals: false,
  layouts: [],
  statuses: [],
  exits: []
}

export function refreshTargets(partial: Partial<RefreshTargets>): RefreshTargets {
  return { ...NOTHING_TO_REFRESH, ...partial }
}

export function isEmptyRefresh(targets: RefreshTargets): boolean {
  return (
    !targets.projects &&
    !targets.worktrees &&
    !targets.terminals &&
    targets.layouts.length === 0 &&
    targets.statuses.length === 0 &&
    targets.exits.length === 0
  )
}

/**
 * The event-to-refetch mapping, and the whole reason the ids travel on the
 * event: a layout change in one worktree names that worktree, so nothing else
 * is re-read because of it.
 */
export function targetsForEvent(event: WorkspaceEvent): RefreshTargets {
  switch (event.type) {
    case 'projects':
      return refreshTargets({ projects: true })
    case 'worktrees':
      return refreshTargets({ worktrees: true })
    case 'terminals':
      return refreshTargets({ terminals: true })
    case 'layout':
      return refreshTargets({ layouts: [event.worktreeId] })
    case 'terminalExited':
      // The runtime emits `terminals` alongside this, so re-reading the list
      // here would fetch it twice for one exit.
      return refreshTargets({ exits: [{ terminalId: event.terminalId, exitCode: event.exitCode }] })
  }
}

/** Union of two batches: a burst of events costs one refetch per collection. */
export function mergeTargets(a: RefreshTargets, b: RefreshTargets): RefreshTargets {
  return {
    projects: a.projects || b.projects,
    worktrees: a.worktrees || b.worktrees,
    terminals: a.terminals || b.terminals,
    layouts: union(a.layouts, b.layouts),
    statuses: union(a.statuses, b.statuses),
    exits: mergeExits(a.exits, b.exits)
  }
}

function union(a: readonly string[], b: readonly string[]): readonly string[] {
  if (b.length === 0) return a
  if (a.length === 0) return b
  return [...new Set([...a, ...b])]
}

/** One exit per terminal; the later event carries the code that is true now. */
function mergeExits(a: readonly TerminalExit[], b: readonly TerminalExit[]): readonly TerminalExit[] {
  if (b.length === 0) return a
  if (a.length === 0) return b
  const byTerminal = new Map(a.map((exit) => [exit.terminalId, exit]))
  for (const exit of b) byTerminal.set(exit.terminalId, exit)
  return [...byTerminal.values()]
}

export type WorkspaceRefresher = {
  /** Feeds one stream event in. */
  push: (event: WorkspaceEvent) => void
  /** Asks for a refetch the UI wants for its own reasons, e.g. opening a tab. */
  request: (targets: RefreshTargets) => void
  /** Runs whatever is pending now and resolves once the queue is idle. */
  flush: () => Promise<void>
  /** Drops work that has not started. Pushing afterwards still works. */
  cancelPending: () => void
}

export type WorkspaceRefresherOptions = {
  run: (targets: RefreshTargets) => Promise<void>
  /** How long a burst is gathered before it runs. */
  windowMs?: number
  onError?: (error: unknown) => void
  /** Timer seam for tests; returns the cancel for the scheduled run. */
  schedule?: (run: () => void, delayMs: number) => () => void
}

/**
 * Short enough that a change made in a shell shows up as fast as the eye reads
 * it, long enough that one action's fan-out is one refetch. The runtime already
 * coalesces on its side; this catches what crosses window boundaries.
 */
export const REFRESH_WINDOW_MS = 30

export function createWorkspaceRefresher(options: WorkspaceRefresherOptions): WorkspaceRefresher {
  const windowMs = options.windowMs ?? REFRESH_WINDOW_MS
  const schedule = options.schedule ?? scheduleWithTimeout

  let pending = NOTHING_TO_REFRESH
  let cancelScheduled: (() => void) | undefined
  let inFlight: Promise<void> | undefined

  const startIfIdle = (): void => {
    cancelScheduled?.()
    cancelScheduled = undefined
    // A batch already running will pick this up when it finishes, and starting
    // a second one is exactly the overlap this queue exists to prevent.
    if (inFlight || isEmptyRefresh(pending)) return

    const batch = pending
    pending = NOTHING_TO_REFRESH
    inFlight = Promise.resolve()
      .then(() => options.run(batch))
      .catch((error: unknown) => options.onError?.(error))
      .then(() => {
        inFlight = undefined
        if (!isEmptyRefresh(pending)) startIfIdle()
      })
  }

  const add = (targets: RefreshTargets): void => {
    pending = mergeTargets(pending, targets)
    if (isEmptyRefresh(pending) || cancelScheduled) return
    // The window opens at the first event of a burst, not the last, so a steady
    // stream of changes still lands every window rather than never.
    cancelScheduled = schedule(startIfIdle, windowMs)
  }

  return {
    push: (event) => add(targetsForEvent(event)),
    request: add,
    flush: async () => {
      while (!isEmptyRefresh(pending) || inFlight) {
        startIfIdle()
        await inFlight
      }
    },
    cancelPending: () => {
      pending = NOTHING_TO_REFRESH
      cancelScheduled?.()
      cancelScheduled = undefined
    }
  }
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

/**
 * Guards a local edit against a read that was already in flight when the user
 * made it. Dragging a pane gutter writes the new tree straight into the store;
 * a `layout.get` issued a moment earlier would otherwise answer with the tree
 * from before the drag and snap the gutter back.
 */
export type LocalEditFence = {
  /** Records that the value under `key` was just changed locally. */
  bump: (key: string) => void
  /** Token to hand back to `isStale` once a read for `key` resolves. */
  mark: (key: string) => number
  isStale: (key: string, token: number) => boolean
}

export function createLocalEditFence(): LocalEditFence {
  const edits = new Map<string, number>()
  return {
    bump: (key) => {
      edits.set(key, (edits.get(key) ?? 0) + 1)
    },
    mark: (key) => edits.get(key) ?? 0,
    isStale: (key, token) => (edits.get(key) ?? 0) !== token
  }
}
