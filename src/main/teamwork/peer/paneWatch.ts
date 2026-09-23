// Joins a teammate's running pane: subscribe first (a read first leaves a gap), then `terminal.read`, and
// drop held frames at or before the answer's frame number — never "whatever arrived before the promise
// settled": one socket read routes a whole batch synchronously, before the `await` continuation runs.

import type { MethodName, ParamsOf, ResultOf, WatchedPaneEvent } from '../../../shared/methods'
import { outputBytes, type Answered } from '../../runtime/peerTransport'
import type { SubscriptionChannel } from '../../runtime/subscriptionHub'

/** The far end, reduced to the three things a watch does with it. */
export type WatchTarget = {
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /**
   * The same, and where the answer sat among the frames `route` delivers. Required: the join has no
   * second way to find that boundary, and every guess loses output or shows it twice.
   */
  callInOrder: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<Answered<M>>
  /** Directs one of the teammate's streams here; returns the undo. */
  route: (subscription: string, onEvent: (event: unknown, sequence: number) => void) => () => void
}

export type PaneWatchOptions = {
  target: WatchTarget
  /** The pane's id **on the owner's machine**, never the namespaced one. */
  terminalId: string
  channel: SubscriptionChannel
  onError?: (error: unknown) => void
}

/** Streams one of a teammate's panes into `channel` until the returned teardown runs; closing it stops the bytes. */
export function watchPane(options: PaneWatchOptions): () => void {
  const { target, terminalId, channel } = options
  /** Streamed frames waiting on the snapshot, each with where it arrived. */
  const held: { event: unknown; sequence: number }[] = []

  const report = (error: unknown): void => options.onError?.(error)

  let stopped = false
  let replaying = true
  let unroute: (() => void) | undefined
  let remote: string | undefined

  const release = (): void => {
    unroute?.()
    unroute = undefined
    const subscription = remote
    remote = undefined
    if (subscription === undefined) return
    // A link that stays up for days would otherwise keep a pane streaming to nobody. A link already gone
    // released everything this side opened when it went.
    void target.call('unsubscribe', { subscription }).catch(report)
  }

  void (async () => {
    try {
      const { subscription } = await target.call('terminal.subscribe', { terminalId })
      if (stopped) {
        void target.call('unsubscribe', { subscription }).catch(report)
        return
      }
      remote = subscription
      unroute = target.route(subscription, (event, sequence) => {
        if (!replaying) {
          channel.emit(event)
          return
        }
        held.push({ event, sequence })
      })

      const { result, sequence: answeredAt } = await target.callInOrder('terminal.read', { terminalId })
      if (stopped) return
      const { data } = result
      // The window (bytes that arrived plus what its `elided` frames name) against the snapshot that
      // replaces it. The scrollback is a contiguous tail, so any shortfall is output no scrollback still
      // holds — the one true elision of this join, subsuming every `elided` the window carried.
      let windowBytes = 0
      for (const { event, sequence } of held) {
        if (sequence <= answeredAt) windowBytes += outputBytes(event)
      }
      const missing = windowBytes - Buffer.byteLength(data, 'utf8')
      if (missing > 0) channel.emit({ type: 'elided', bytes: missing } satisfies WatchedPaneEvent)
      if (data.length > 0) channel.emit({ type: 'data', data } satisfies WatchedPaneEvent)
      replaying = false
      // Held output at or before the answer's frame is overlap the snapshot carries; after it is the live
      // tail. An exit or a title is kept wherever it sat because a snapshot cannot carry one.
      for (const { event, sequence } of held.splice(0)) {
        if (sequence <= answeredAt && isOverlap(event)) continue
        channel.emit(event)
      }
    } catch (error) {
      if (stopped) return
      options.onError?.(error)
      // Said rather than swallowed: a pane that stopped updating would read as a teammate who went quiet.
      channel.emit({ type: 'lost', reason: reasonFor(error) } satisfies WatchedPaneEvent)
      channel.close()
    }
  })()

  return () => {
    if (stopped) return
    stopped = true
    replaying = false
    held.length = 0
    release()
  }
}

/**
 * Whether the snapshot already accounts for this frame: its bytes do, and an `elided` from the window
 * has been weighed against the snapshot above.
 */
function isOverlap(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false
  const type = (event as { type?: unknown }).type
  return type === 'data' || type === 'elided'
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
