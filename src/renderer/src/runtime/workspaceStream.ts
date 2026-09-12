// A workspace subscription that stays up.
//
// The raw `subscribeWorkspace` is one call and one stream: if the runtime is not
// answering yet, it rejects, and the page is then deaf to every change until
// something asks again. UI code wants the opposite — start watching, keep
// watching — so this retries until it has a stream and hands back a close that
// is safe to call from a React cleanup.
//
// Reloading the page is handled by the two ends together: the runtime drops
// every subscription a page opened as soon as that page starts navigating away,
// and the fresh page starts its own watch, so a reload swaps one live stream for
// another and never accumulates them.

import type { WorkspaceEvent } from '@shared/methods'
import { subscribeWorkspace, type Subscription } from './runtimeClient'

/** First retry delay; it doubles up to the ceiling while the runtime is silent. */
const RETRY_BASE_MS = 250
const RETRY_CEILING_MS = 5_000

export type WorkspaceWatch = {
  /** Idempotent. Stops retrying and closes the stream if one is open. */
  close: () => Promise<void>
}

export type WatchWorkspaceOptions = {
  /** Seam for tests and for a client that opens the stream its own way. */
  open?: (onEvent: (event: WorkspaceEvent) => void) => Promise<Subscription>
  /** Reported rather than thrown: a watch that is retrying is not a failure. */
  onError?: (error: unknown) => void
  retryBaseMs?: number
  retryCeilingMs?: number
}

export function watchWorkspace(
  onEvent: (event: WorkspaceEvent) => void,
  options: WatchWorkspaceOptions = {}
): WorkspaceWatch {
  const open = options.open ?? subscribeWorkspace
  const baseMs = options.retryBaseMs ?? RETRY_BASE_MS
  const ceilingMs = options.retryCeilingMs ?? RETRY_CEILING_MS

  let closed = false
  let subscription: Subscription | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let delayMs = baseMs

  const attempt = (): void => {
    if (closed) return
    open((event) => {
      if (!closed) onEvent(event)
    }).then(
      (opened) => {
        delayMs = baseMs
        // Closed while the subscribe was in flight: end the stream we just won.
        if (closed) void opened.close()
        else subscription = opened
      },
      (error: unknown) => {
        options.onError?.(error)
        if (closed) return
        retryTimer = setTimeout(attempt, delayMs)
        delayMs = Math.min(delayMs * 2, ceilingMs)
      }
    )
  }

  attempt()

  return {
    close: async () => {
      if (closed) return
      closed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      const live = subscription
      subscription = undefined
      await live?.close()
    }
  }
}
