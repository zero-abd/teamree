// Joining a pane that is already running, from the other side of a relay.
//
// THE JOIN IS THE WHOLE FILE. A watcher opening a teammate's pane needs two
// things that arrive from two different places: the scrollback, which
// `terminal.read` answers with, and everything after it, which
// `terminal.subscribe` streams. Neither method learns that the caller is
// remote, which is the architectural claim this milestone rests on — so the
// joining has to happen here, at the reader, and it has exactly two ways to go
// wrong.
//
// **A gap** if the scrollback is read first: everything the pane says between
// the read and the subscribe is gone, and a reader is shown a pane that skipped
// a paragraph. So the subscribe goes first, always.
//
// **A duplicate overlap** if the stream is then replayed over the snapshot:
// output that arrived while the read was in flight is in the snapshot *and* in
// the stream, and a reader is shown it twice. The usual fix is to count bytes
// and trim, which needs the two sides to agree about an offset they have no
// reason to agree about.
//
// There is a better one, and it costs nothing, because the ordering is already
// exact. One request and one response travel the same Noise stream in the order
// they were written, and the owner writes a stream frame when the pane speaks
// and the read's answer when it is asked. So every frame received *before* the
// read's answer describes output the owner had already put in the scrollback
// that answer carries, and every frame after it does not. The rule that falls
// out needs no arithmetic: hold the stream until the snapshot lands, write the
// snapshot, then throw the held output away and go live.
//
// Two things survive that discarding, and both are facts rather than volume: an
// exit and a title. A scrollback holds neither, so a watcher who lost them
// would be told a pane is still running when it has already finished.

import type { MethodName, ParamsOf, ResultOf, WatchedPaneEvent } from '../../../shared/methods'
import type { SubscriptionChannel } from '../../runtime/subscriptionHub'

/** The far end, reduced to the two things a watch does with it. */
export type WatchTarget = {
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /** Directs one of the teammate's streams here; returns the undo. */
  route: (subscription: string, onEvent: (event: unknown) => void) => () => void
}

export type PaneWatchOptions = {
  target: WatchTarget
  /** The pane's id **on the owner's machine**, never the namespaced one. */
  terminalId: string
  channel: SubscriptionChannel
  onError?: (error: unknown) => void
}

/**
 * Streams one of a teammate's panes into `channel` until the returned teardown
 * runs. Closing it is what stops the bytes: nothing here ever leaves a
 * subscription open on somebody else's machine for a pane nobody is reading.
 */
export function watchPane(options: PaneWatchOptions): () => void {
  const { target, terminalId, channel } = options
  const held: unknown[] = []

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
    // The far side would release it when the link dropped anyway, but a link
    // that stays up for days would otherwise keep a pane streaming to nobody,
    // which is the exact cost `docs/teamwork.md` says bytes-on-demand exists to
    // avoid. A link that has already gone cannot be told and does not need to
    // be: it released everything this side opened when it went.
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
      unroute = target.route(subscription, (event) => {
        if (!replaying) {
          channel.emit(event)
          return
        }
        held.push(event)
      })

      const { data } = await target.call('terminal.read', { terminalId })
      if (stopped) return
      if (data.length > 0) channel.emit({ type: 'data', data } satisfies WatchedPaneEvent)
      replaying = false
      // Everything held arrived before that answer did, so the snapshot already
      // contains it — except for what a snapshot cannot contain.
      for (const event of held.splice(0)) if (!isOutput(event)) channel.emit(event)
    } catch (error) {
      if (stopped) return
      options.onError?.(error)
      // Said rather than swallowed: a watcher left looking at a pane that
      // stopped updating would read it as a teammate who went quiet.
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

function isOutput(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'data'
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
