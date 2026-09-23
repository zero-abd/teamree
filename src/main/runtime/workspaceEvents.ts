// The workspace change stream: one process-wide bus, so a mutation over the CLI
// socket reaches a GUI subscriber on IPC. Events name a collection, not a delta,
// so a subscriber refetches and cannot drift.

import type { WorkspaceEvent } from '../../shared/methods'

/**
 * How long events are held before delivery: long enough to swallow one action's
 * fan-out, short enough that a click still feels instant.
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

/** What makes two events the same invalidation; an id stays in the key. */
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
 * their keys were first seen. One stream per subscriber.
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
      // Re-setting a key keeps its position and takes the newer payload.
      pending.set(coalesceKey(event), event)
      // The window runs from the first event of a burst, so a continuous stream still delivers.
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
