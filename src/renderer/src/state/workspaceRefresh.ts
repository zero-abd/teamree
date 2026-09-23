// Workspace events become refetches through one queue: two overlapping `worktree.list` calls
// can resolve in either order, and the older answer landing last would stick. At most one batch
// is in flight and events during it accumulate into the next; `LocalEditFence` is the reverse race.

import type { WorkspaceEvent } from '@shared/methods'

/** What one batch of events says has to be re-read. */
export type RefreshTargets = {
  projects: boolean
  worktrees: boolean
  terminals: boolean
  /** Rosters. The event carries no project id, so the reader re-reads the rosters it already holds. */
  members: boolean
  /** Link states and what teammates are showing; no project id either, so the projects on screen. */
  teammates: boolean
  /** What the update check has to say: one small read, nothing to narrow. */
  updates: boolean
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
  members: false,
  teammates: false,
  updates: false,
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
    !targets.members &&
    !targets.teammates &&
    !targets.updates &&
    targets.layouts.length === 0 &&
    targets.statuses.length === 0 &&
    targets.exits.length === 0
  )
}

/** The event-to-refetch mapping: a layout change names its worktree, so nothing else is re-read for it. */
export function targetsForEvent(event: WorkspaceEvent): RefreshTargets {
  switch (event.type) {
    case 'projects':
      return refreshTargets({ projects: true })
    case 'worktrees':
      return refreshTargets({ worktrees: true })
    case 'terminals':
      return refreshTargets({ terminals: true })
    case 'members':
      return refreshTargets({ members: true })
    // A roster change moves the link set too, but the runtime emits `teammates` once it has
    // reconciled; coupling the two here would refetch twice for one thing.
    case 'teammates':
      return refreshTargets({ teammates: true })
    case 'updates':
      return refreshTargets({ updates: true })
    case 'layout':
      return refreshTargets({ layouts: [event.worktreeId] })
    case 'terminalExited':
      // The runtime emits `terminals` alongside this; re-reading here would fetch twice for one exit.
      return refreshTargets({ exits: [{ terminalId: event.terminalId, exitCode: event.exitCode }] })
  }
}

/** Union of two batches: a burst of events costs one refetch per collection. */
export function mergeTargets(a: RefreshTargets, b: RefreshTargets): RefreshTargets {
  return {
    projects: a.projects || b.projects,
    worktrees: a.worktrees || b.worktrees,
    terminals: a.terminals || b.terminals,
    members: a.members || b.members,
    teammates: a.teammates || b.teammates,
    updates: a.updates || b.updates,
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
 * Short enough that a shell change shows as fast as the eye reads it, long enough that one action's
 * fan-out is one refetch. The runtime coalesces on its side; this catches what crosses window boundaries.
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
    // A running batch picks this up when it finishes; a second one is the overlap this queue prevents.
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
    // The window opens at the first event of a burst, so a steady stream still lands every window.
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
 * Guards a local edit against a read already in flight: a `layout.get` issued just before a gutter
 * drag would answer with the tree from before the drag and snap the gutter back.
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
