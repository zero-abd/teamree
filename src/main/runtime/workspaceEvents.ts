// The workspace change stream, from whatever caused a change to whoever is
// watching.
//
// One process-wide bus sits between producers and subscribers, and producers
// publish without knowing whether anyone is listening or which transport asked.
// That indirection is the entire point of the feature: a mutation arriving over
// the CLI socket reaches a GUI subscriber on Electron IPC because both ends meet
// here rather than in a transport.
//
// Events are deliberately coarse — they name a collection, not a delta — so a
// subscriber refetches and cannot drift out of sync with the runtime.

import type { WorkspaceEvent } from '../../shared/methods'

/**
 * How long events are held before delivery. One user action fans out into
 * several changes (creating a worktree writes a record, then transitions it;
 * opening a terminal also rewrites a layout), and a subscriber that refetches
 * per event would refetch several times for one action. Short enough that a
 * click still feels instant, long enough to swallow that fan-out.
 */
export const WORKSPACE_EVENT_COALESCE_MS = 40

export type WorkspaceEventListener = (event: WorkspaceEvent) => void

/** Subscribe, get an unsubscribe back. Producers only ever call `emit`. */
export class WorkspaceEventBus {
  readonly #listeners = new Set<WorkspaceEventListener>()

  on(listener: WorkspaceEventListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  emit(event: WorkspaceEvent): void {
    // Copied first: a listener may unsubscribe itself while being notified.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must never abort the mutation that fired this.
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size
  }
}

/**
 * What makes two events the same invalidation. Events carrying an id keep it in
 * the key, so a burst touching two worktrees' layouts stays two events while a
 * burst touching one stays one.
 */
export function coalesceKey(event: WorkspaceEvent): string {
  switch (event.type) {
    case 'layout':
      return `layout:${event.worktreeId}`
    case 'terminalExited':
      return `terminalExited:${event.terminalId}`
    default:
      return event.type
  }
}

export type CoalescedStream = {
  push: (event: WorkspaceEvent) => void
  /** Drops anything pending and its timer. The subscription is over. */
  cancel: () => void
}

export type CoalescedStreamOptions = {
  windowMs?: number
  /** Timer seam for tests; returns the cancel for the scheduled run. */
  schedule?: (run: () => void, delayMs: number) => () => void
}

/**
 * Buffers events for one window and delivers at most one per key, in the order
 * their keys were first seen. Each subscriber gets its own stream so a slow or
 * departing subscriber cannot hold up anyone else's events.
 */
export function createCoalescedStream(
  deliver: WorkspaceEventListener,
  options: CoalescedStreamOptions = {}
): CoalescedStream {
  const windowMs = options.windowMs ?? WORKSPACE_EVENT_COALESCE_MS
  const schedule = options.schedule ?? scheduleWithTimeout
  const pending = new Map<string, WorkspaceEvent>()
  let cancelScheduled: (() => void) | undefined

  const flush = (): void => {
    cancelScheduled = undefined
    const batch = [...pending.values()]
    pending.clear()
    for (const event of batch) deliver(event)
  }

  return {
    push: (event) => {
      // Re-setting an existing key keeps its original position and takes the
      // newer payload, which is what a client should act on.
      pending.set(coalesceKey(event), event)
      // The window runs from the first event of a burst, not the last, so a
      // continuous stream of changes still gets delivered every window.
      if (!cancelScheduled) cancelScheduled = schedule(flush, windowMs)
    },
    cancel: () => {
      pending.clear()
      cancelScheduled?.()
      cancelScheduled = undefined
    }
  }
}

function scheduleWithTimeout(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  // A pending invalidation must never be the reason a process stays alive.
  timer.unref?.()
  return () => clearTimeout(timer)
}
