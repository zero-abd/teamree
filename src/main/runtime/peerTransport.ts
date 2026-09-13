// THE FOURTH TRANSPORT.
//
// The runtime already answers one catalogue of methods over Electron IPC for
// the window and over a unix socket for the CLI. A teammate is another way in,
// and this file is deliberately the same shape as `socketServer.ts`: give the
// connection an id, give it a frame decoder, give it a subscription scope, feed
// whatever arrives to the one dispatcher, and write what comes back. Nothing
// below this line knows the caller is two thousand miles away, which is what
// makes `terminal.subscribe` reachable over a peer link in milestone C without
// touching the terminal service at all.
//
// Two things are not like the socket server, and both are because the caller is
// somebody else's machine:
//
// **The bytes are encrypted.** What arrives is a Noise transport message; what
// comes out of it is the same newline-delimited JSON a CLI client sends.
// `peerFraming.ts` owns the boundary between the two.
//
// **The catalogue is not fully open.** A CLI client is the user; a peer is a
// teammate. `docs/teamwork.md` means for a teammate to see panes and to type
// into one, and it does not mean for them to remove a worktree or drop a
// project. So a peer's reachable surface is an explicit allow-list: C added the
// two reads that stream a pane's output and D added `terminal.write`, and
// nothing else has ever been on it. Everything absent from the set answers as
// an unknown method, which is what it is from where the peer stands.
//
// **One of those methods runs code.** `terminal.write` is the whole of
// milestone D and the whole of the risk in this product, so it does not simply
// join the list. Every one of them passes `onRemoteWrite` first — a synchronous
// verdict from the thing that knows whose link this is, whether that person is
// still on the roster, and whether the owner has muted the pane — and a
// transport given no such verdict carries no keystrokes at all. The check and
// the dispatch are in one task with nothing awaited between them, which is what
// makes a mute instant: a mute can only be applied in some later task, and the
// keystroke after it is refused.
//
// Refusals are answered rather than dropped. A keystroke that went nowhere and
// said nothing would leave the person who typed it believing they had typed
// into somebody's shell, which is its own kind of lie.
//
// **The wire has a budget and a pane can outrun it.** `relay/README.md` gives a
// connection 200 frames and 4 MiB a second, and an agent that prints a build log
// can beat both. So stream frames are paced on the way out and consecutive
// output for one pane is merged, which is lossless — concatenating two chunks of
// a byte stream is the same byte stream. What is not lossless is the bound on
// how much may be held while the wire catches up, and past it the oldest bytes
// go. That is the one case where a watcher is shown less than the owner
// produced, so it is the one case where the watcher is told: an `elided` event
// carries the byte count, in the stream, where the hole is. Dropping output
// silently would make the whole feature a lie.
//
// Pacing holds output back, so it can also reorder it against something that is
// not paced: a `terminal.read` answer would otherwise overtake output its own
// scrollback already carries, and a watcher joining the two by frame order
// would be shown that output twice. So a read flushes its pane first, and the
// answer leaves after everything it describes.

import { MAX_REMOTE_WRITE_BYTES, type MethodName, type ParamsOf, type ResultOf } from '../../shared/methods'
import type { PeerSession } from '../../shared/peer'
import {
  encodeFrame,
  ErrorCode,
  isStreamEvent,
  type Frame,
  type Response,
  type StreamEvent
} from '../../shared/protocol'
import type { Dispatcher } from './dispatcher'
import { createLineReader, encodeLine } from './peerFraming'
import type { SubscriptionHub } from './subscriptionHub'

/**
 * What a teammate may ask this runtime to do.
 *
 * Presence, the two reads that let somebody watch a pane — `terminal.read` for
 * the scrollback they are joining, `terminal.subscribe` for everything after it
 * — and `terminal.write`, which types into one. That last is the only entry
 * that changes anything on this machine, and it is gated again below.
 *
 * `terminal.resize` and `terminal.close` are absent and stay absent: a
 * teammate's window is not this pane's window, and a reader who could end
 * somebody's process would be a different feature. Everything touching git is
 * absent for the reason `docs/teamwork.md` gives — "anyone can type" is a
 * statement about panes, not a licence to delete a colleague's worktree.
 *
 * Adding a method here is the deliberate act of handing a teammate a new
 * capability, so the set is spelled out rather than derived.
 */
export const PEER_METHODS: readonly MethodName[] = [
  'peer.presence',
  'peer.subscribe',
  'terminal.read',
  'terminal.subscribe',
  'terminal.write',
  'unsubscribe'
] as const

/**
 * How long a call to the teammate may go unanswered before it is refused.
 *
 * Every method on `PEER_METHODS` is answered out of memory or out of a pty
 * buffer on the far machine, so thirty seconds is not a slow answer, it is no
 * answer. The link's own silence deadline in `peerLink.ts` is the real backstop
 * and is deliberately longer; this is the cheaper belt, and what it buys is
 * that no single wedged call can become a keystroke that vanished, a watch that
 * never opens, or a promise nothing ever settles.
 */
export const PEER_CALL_TIMEOUT_MS = 30_000

/**
 * How long output for one pane is gathered before it is sent.
 *
 * Fifty flushes a second per watched pane, against the relay's 200 frames, and
 * a twentieth of a second is under the threshold at which a reader would call a
 * terminal laggy. A quiet pane pays none of it: the first chunk after a pause
 * goes out immediately and only a pane that is still talking is paced.
 */
export const STREAM_FLUSH_MS = 20

/**
 * The share of the relay's 4 MiB/s one connection's terminal output may take.
 *
 * A quarter, because a link carries presence snapshots and several panes at
 * once, and because a budget spent exactly is a budget the relay closes the
 * connection for. A terminal that sustains a megabyte a second is not being
 * read by anybody anyway.
 */
export const STREAM_BYTES_PER_SECOND = 1_048_576

/**
 * How much of a pane's output may wait for the wire before the oldest of it is
 * dropped.
 *
 * One relay frame's worth. A watcher wants the newest output, not a faithful
 * replay of a burst from ten seconds ago, so the buffer keeps the tail and says
 * how much of the head it threw away.
 */
export const STREAM_BUFFER_BYTES = 262_144

/** One keystroke a teammate sent, before anything has been decided about it. */
export type RemoteWriteRequest = {
  terminalId: string
  data: string
  /** Counted once, here, because every decision below is about size. */
  bytes: number
}

/**
 * What the owner's machine decided about one keystroke.
 *
 * A refusal carries the words the teammate is given, because they are the only
 * thing that tells somebody two thousand miles away why their typing went
 * nowhere.
 */
export type RemoteWriteVerdict = { ok: true } | { ok: false; code: ErrorCode; message: string }

/**
 * What the owner's machine decided about one read.
 *
 * The same shape as a write's verdict, and deliberately a separate name: what
 * they permit is not the same thing, and a single type would invite one call
 * site to be wired to the other's judge.
 */
export type RemoteReadVerdict = { ok: true } | { ok: false; code: ErrorCode; message: string }

/**
 * How many streams one teammate may hold open on this runtime at once.
 *
 * A watcher needs one for presence and one for each pane they are reading, and
 * nobody reads thirty panes. Every record past that is a pacing buffer this
 * machine keeps on somebody else's say-so, and `peer.subscribe` answers with a
 * full snapshot each time it is called — so an unbounded count is a way to
 * spend this process's memory from the other end of a relay.
 */
export const MAX_PEER_SUBSCRIPTIONS = 32

/**
 * The methods on the allow-list that leave a subscription behind.
 *
 * Spelled out for the same reason `PEER_METHODS` is: which calls cost this
 * machine something that outlives the call is a fact about the catalogue, and
 * guessing at it from a method's name would be a rule that quietly stopped
 * covering the next one.
 */
const SUBSCRIBING_METHODS: readonly MethodName[] = ['peer.subscribe', 'terminal.subscribe'] as const

export type PeerTransportOptions = {
  session: PeerSession
  /** Hands one Noise transport message to whatever is carrying them. */
  send: (message: Uint8Array) => void
  dispatch: Dispatcher
  subscriptions: SubscriptionHub
  /** Unique per link, and the key every subscription this peer opens is owned by. */
  connectionId: string
  /** Defaults to `PEER_METHODS`; a test narrows it to prove the gate is real. */
  allowedMethods?: readonly MethodName[]
  /**
   * Stream frames the *peer* pushed to us, for a subscription we opened there.
   *
   * `sequence` is where the frame sat in the received order, which is what a
   * reader joining a stream to a snapshot compares against the answer that
   * carried the snapshot. See `received` below for why the clock has to be this
   * one.
   */
  onStreamEvent?: (stream: string, event: unknown, sequence: number) => void
  /**
   * Which of this machine's panes the teammate currently has open, whenever
   * that changes.
   *
   * Observed here rather than reported by the terminal service, because this is
   * the only place that knows a caller is a teammate at all — which is exactly
   * the property the rest of the design depends on, and the reason the owner
   * can be told who is reading without the pane learning what a peer is.
   */
  onWatchChange?: (terminalIds: readonly string[]) => void
  /**
   * Asked about every keystroke this teammate sends, before it reaches a pane.
   *
   * Observed in the same place and for the same reason as the watching above:
   * this is the only layer that knows the caller is a teammate at all, so it is
   * the only layer that can attribute a write, record it, or refuse it — and
   * the terminal service on the other side of the dispatcher goes on not
   * knowing what a peer is.
   *
   * Synchronous on purpose. Nothing is awaited between the verdict and the
   * dispatch, so a mute applied while a keystroke was in flight is applied to
   * that keystroke rather than to some later one. **A transport without this
   * refuses every write**, because a byte reaching a pty with nobody able to
   * say who sent it is the one thing this design may not do.
   */
  onRemoteWrite?: (write: RemoteWriteRequest) => RemoteWriteVerdict
  /**
   * Whether this teammate may read that pane. Asked of the same thing that
   * knows whose link the request arrived on, for the same reason the write
   * verdict is: a transport cannot know what a project is.
   *
   * A transport wired without one carries no reads at all, which is the safe
   * direction: a peer transport that forgot to ask would otherwise stream every
   * pane on the machine.
   */
  onRemoteRead?: (terminalId: string) => RemoteReadVerdict
  /**
   * Timers and the clock, so the pacing below is driven rather than slept
   * through. Defaults to the real ones.
   */
  scheduler?: TransportScheduler
  /**
   * Called once, on the first transport message from the peer that decrypts.
   *
   * This is key confirmation, and it is not the same event as the handshake
   * completing. A responder finishes `IK` having only written message 2, so a
   * replayer with a captured message 1 and no private key reaches `established`
   * carrying the real peer's static key. It can never produce a transport
   * message, because that needs keys it does not have — so the first one that
   * authenticates is the first evidence anybody is actually there, and it is
   * evidence a recording cannot manufacture.
   */
  onConfirmed?: () => void
  /**
   * The link can no longer be trusted and must be torn down: a Noise failure, a
   * frame that is not JSON. Both are unrecoverable — a Noise stream has no
   * resynchronisation point — so this is never a warning.
   */
  onFatal: (reason: string) => void
  /** Failures that cost one call and not the link. */
  onError?: (error: unknown) => void
}

/** The sliver of a clock the outbound pacing needs. */
export type TransportScheduler = {
  now: () => number
  /** Returns the cancel for the timer it set. */
  setTimer: (run: () => void, delayMs: number) => () => void
}

/** An answer from the peer, and the position of the frame that carried it. */
export type Answered<M extends MethodName> = { result: ResultOf<M>; sequence: number }

export type PeerTransport = {
  /** A request to the peer, typed from the same catalogue. */
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /**
   * The same request, and where the peer's answer sat in the received order.
   *
   * For the one caller that has to place an answer among the stream frames
   * around it. A promise cannot carry that by itself: it settles in a later
   * task than the one that read its frame, and by then any frames decoded
   * behind it in the same socket read have already been routed.
   */
  callInOrder: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<Answered<M>>
  /** One Noise transport message, exactly as the peer framed it. */
  receive: (message: Uint8Array) => void
  /**
   * A content frame carrying nothing.
   *
   * The relay's idle deadline counts content frames only — a text ping does not
   * reset it — so a pair that is merely quiet has to say something in the one
   * language the relay is not allowed to read. An empty line is a whole,
   * well-formed frame that the decoder on the far side drops without waking
   * anything, which makes it the cheapest legal thing to say.
   */
  keepalive: () => void
  /**
   * When this session last turned something from the peer into plaintext, on
   * the injected clock.
   *
   * The only honest evidence anybody is there. A socket that has not been
   * closed is not evidence — a machine that suspends leaves one open on both
   * hosts — and neither is a frame this side sent. `peerLink.ts` reads this
   * and nothing else to decide whether a link is still a link.
   */
  readonly lastDecryptedAt: number
  /** Fails every call still in flight and releases this peer's subscriptions. */
  close: (reason: string) => void
}

export function createPeerTransport(options: PeerTransportOptions): PeerTransport {
  const allowed = new Set<string>(options.allowedMethods ?? PEER_METHODS)
  const subscribing = new Set<string>(SUBSCRIBING_METHODS)
  const pending = new Map<
    string,
    { resolve: (answer: never) => void; reject: (error: Error) => void; cancel: () => void }
  >()
  const reader = createLineReader(options.session)
  const scheduler = options.scheduler ?? realScheduler
  /** Request id to the pane it asked to watch, until its answer comes back. */
  const asked = new Map<string, string>()
  /** Subscription id to the pane it streams, for every watch the peer holds. */
  const watching = new Map<string, string>()
  /** Subscriptions the peer has itself asked to end, so its own goodbye is not echoed. */
  const releasing = new Set<string>()
  const paced = new Map<string, PacedStream>()
  /** One second's worth of bytes, spent by flushes and refilled by time. */
  let budget = STREAM_BYTES_PER_SECOND
  let budgetAt = scheduler.now()
  let nextId = 0
  /**
   * Frames read off this session, counted.
   *
   * The clock that says which of two frames came first, and the only one that
   * can. One socket read decodes a batch and `receive` routes the batch in a
   * synchronous loop, so a stream frame decoded *after* an answer still reaches
   * its route before that answer's promise continuation runs. Anything joining
   * a stream to a snapshot has to compare positions in this count rather than
   * the order in which its own callbacks happened to be scheduled.
   */
  let received = 0
  let live = true
  let confirmed = false
  /**
   * Starts at construction rather than at zero, so a session that has said
   * nothing yet reads as quiet for no time rather than quiet since the epoch.
   * The window before the first frame is the handshake's to police, and
   * `peerLink.ts` has a separate deadline for it.
   */
  let decryptedAt = scheduler.now()

  const write = (frame: Frame): void => {
    if (!live) return
    try {
      for (const message of encodeLine(options.session, encodeFrame(frame))) options.send(message)
    } catch (error) {
      // Encryption only fails once the session is already unusable, so there is
      // nothing left to send an error over.
      fail(messageOf(error))
    }
  }

  const fail = (reason: string): void => {
    if (!live) return
    live = false
    for (const stream of paced.values()) stream.cancel?.()
    paced.clear()
    options.subscriptions.closeConnection(options.connectionId)
    for (const [, waiter] of pending) {
      waiter.cancel()
      waiter.reject(new Error(reason))
    }
    pending.clear()
    options.onFatal(reason)
  }

  const announceWatches = (): void => {
    options.onWatchChange?.([...new Set(watching.values())])
  }

  // ------------------------------------------------------------- the pacing

  /** Refills the connection's byte budget for the time that has passed. */
  const refill = (now: number): void => {
    const earned = ((now - budgetAt) * STREAM_BYTES_PER_SECOND) / 1000
    budgetAt = now
    if (earned > 0) budget = Math.min(STREAM_BYTES_PER_SECOND, budget + earned)
  }

  /**
   * One stream's waiting output, onto the wire.
   *
   * `force` spends past the byte budget instead of leaving the remainder for
   * the next flush. Only the answer to a `terminal.read` asks for it, and only
   * because a remainder left behind would be output the answer's own scrollback
   * already contains, arriving after it — see `flushPane`. The debit still
   * happens, so the budget repays itself at the next flushes rather than the
   * spend going unrecorded, and the most one read can push out early is the one
   * buffer `STREAM_BUFFER_BYTES` bounds.
   */
  const flush = (streamId: string, stream: PacedStream, force = false): void => {
    if (!live) return
    const now = scheduler.now()
    refill(now)
    stream.at = now

    // Before the output it precedes, because that is where the hole is: the
    // bytes that went were the ones in front of whatever is about to be sent.
    if (stream.lost > 0) {
      write({ stream: streamId, event: { type: 'elided', bytes: stream.lost } })
      stream.lost = 0
    }

    while (stream.items.length > 0) {
      const item = stream.items[0]
      if (item === undefined) break
      if (item.kind === 'event') {
        stream.items.shift()
        write({ stream: streamId, event: item.event })
        continue
      }
      if (!force && item.bytes > budget) break
      stream.items.shift()
      stream.bytes -= item.bytes
      budget -= item.bytes
      write({ stream: streamId, event: { type: 'data', data: item.data } })
    }

    // The record stays even when it is empty: it remembers when this stream
    // last flushed, and a stream that forgot that would let every chunk of a
    // burst out on its own leading edge and pace nothing at all. It is dropped
    // when the subscription is.
    if (stream.items.length === 0 && stream.lost === 0) return
    arm(streamId, stream)
  }

  /**
   * Everything one pane has waiting, out before the answer that describes it.
   *
   * The pacer is the only thing on this machine that can put a pane's output on
   * the wire *after* a scrollback that already contains it: the scrollback is
   * taken the moment the read is handled, while output from a twentieth of a
   * second ago may still be sitting here waiting for its timer. A reader joining
   * a stream to a snapshot decides what to drop by frame order, so output that
   * overtook its own answer would be shown twice — the one thing this seam
   * exists to prevent.
   *
   * Called between the handler taking the scrollback and the answer being
   * written, which is inside a single turn of the loop: everything from the
   * dispatcher to here is microtasks, and a pty's output arrives in a task of
   * its own. So this flushes exactly what the answer carries and never anything
   * later than it.
   */
  const flushPane = (terminalId: string): void => {
    for (const [subscriptionId, watched] of watching) {
      if (watched !== terminalId) continue
      const stream = paced.get(subscriptionId)
      if (!stream) continue
      stream.cancel?.()
      stream.cancel = undefined
      flush(subscriptionId, stream, true)
    }
  }

  const arm = (streamId: string, stream: PacedStream): void => {
    if (stream.cancel) return
    stream.cancel = scheduler.setTimer(() => {
      stream.cancel = undefined
      flush(streamId, stream)
    }, STREAM_FLUSH_MS)
  }

  /** Keeps the tail and counts the head it dropped. */
  const evict = (stream: PacedStream): void => {
    while (stream.bytes > STREAM_BUFFER_BYTES) {
      const first = stream.items[0]
      // Only output can be thrown away. An exit or a title is a fact, not a
      // volume, and a watcher that lost one would be told the pane is still
      // running when it is not.
      if (first === undefined || first.kind !== 'data') return
      const over = stream.bytes - STREAM_BUFFER_BYTES
      if (first.bytes <= over) {
        stream.items.shift()
        stream.bytes -= first.bytes
        stream.lost += first.bytes
        continue
      }
      const kept = first.data.slice(Math.ceil(over / averageBytesPerChar(first)))
      const keptBytes = byteLength(kept)
      stream.lost += first.bytes - keptBytes
      stream.bytes -= first.bytes - keptBytes
      first.data = kept
      first.bytes = keptBytes
    }
  }

  /**
   * Everything a subscription pushes, on its way to the wire.
   *
   * Presence snapshots and every other event go straight out: they are small,
   * rare, and a snapshot held back is a sidebar that lags for no gain. Only a
   * pane's output is paced — and once a pane has output waiting, its own exit
   * and title events queue behind it, because a reader must not be told a pane
   * finished before being shown what it said.
   */
  const publish = (frame: StreamEvent): void => {
    if (!live) return
    const existing = paced.get(frame.stream)
    const data = outputOf(frame.event)
    // Nothing is waiting, so nothing is held back: a presence snapshot and a
    // pane's exit both go straight out.
    if (data === undefined && (!existing || existing.items.length === 0)) {
      write(frame)
      return
    }

    const stream = existing ?? { items: [], bytes: 0, lost: 0, at: 0, cancel: undefined }
    if (!existing) paced.set(frame.stream, stream)

    if (data === undefined) {
      stream.items.push({ kind: 'event', event: frame.event })
    } else {
      const last = stream.items[stream.items.length - 1]
      const bytes = byteLength(data)
      // Lossless: two consecutive chunks of one byte stream concatenate into
      // the same byte stream, so merging them costs the reader nothing.
      if (last !== undefined && last.kind === 'data') {
        last.data += data
        last.bytes += bytes
      } else {
        stream.items.push({ kind: 'data', data, bytes })
      }
      stream.bytes += bytes
      evict(stream)
    }

    // Leading edge: a pane that has been quiet is sent the moment it speaks, so
    // watching is not uniformly a twentieth of a second behind.
    if (!stream.cancel && scheduler.now() - stream.at >= STREAM_FLUSH_MS) flush(frame.stream, stream)
    else arm(frame.stream, stream)
  }

  // The peer gets its own subscription scope, so whatever it opened dies with
  // the link and cannot outlive the machine that asked for it. Its end is
  // reported back, because a pane that exits ends the stream from the producer
  // side and the owner must stop being told somebody is reading it.
  options.subscriptions.openConnection(options.connectionId, publish, (subscriptionId) => {
    const stream = paced.get(subscriptionId)
    if (stream) {
      stream.cancel?.()
      paced.delete(subscriptionId)
    }
    const asked = releasing.delete(subscriptionId)
    if (!watching.delete(subscriptionId)) return
    announceWatches()
    // The owner closed the pane out from under a reader. Nothing else would
    // tell them: the stream simply stops, and a watcher left looking at a
    // window that no longer updates would read it as a teammate gone quiet.
    // A peer that ended its own subscription already knows and is not told.
    if (!asked) write({ stream: subscriptionId, event: { type: 'lost', reason: 'the owner closed this pane' } })
  })

  const handleResponse = (response: Response, sequence: number): void => {
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    waiter.cancel()
    if (response.ok) waiter.resolve({ result: response.result, sequence } as never)
    else waiter.reject(new PeerCallError(response.error.code, response.error.message))
  }

  const handleRequest = (value: unknown): void => {
    const method = methodOf(value)
    if (method !== undefined && !allowed.has(method)) {
      // Deliberately the same answer a method that does not exist gets. From
      // where the peer stands that is exactly what this is.
      write({
        id: idOf(value),
        ok: false,
        error: { code: ErrorCode.UnknownMethod, message: `${method} is not a method a teammate can call` }
      })
      return
    }
    if (
      method !== undefined &&
      subscribing.has(method) &&
      options.subscriptions.countFor(options.connectionId) >= MAX_PEER_SUBSCRIPTIONS
    ) {
      // Answered rather than dropped, and answered with the reason: a teammate
      // that has genuinely opened too many panes can close some, and one that
      // is not going to learns nothing from this it did not already know.
      write({
        id: idOf(value),
        ok: false,
        error: {
          code: ErrorCode.Conflict,
          message: `this link already holds ${MAX_PEER_SUBSCRIPTIONS} streams; release one before opening another`
        }
      })
      return
    }

    if (method === 'terminal.write') {
      const verdict = judgeWrite(value)
      if (!verdict.ok) {
        write({ id: idOf(value), ok: false, error: { code: verdict.code, message: verdict.message } })
        return
      }
    }
    // Reading is scoped too, and was not. `terminal.read` and
    // `terminal.subscribe` went to the dispatcher carrying nothing but the id
    // the caller named, so a teammate on one repository's roster could stream a
    // pane of a project they hold no key for. Typing has been scoped since it
    // was built; this is reading catching up.
    if (method === 'terminal.read' || method === 'terminal.subscribe') {
      const terminalId = terminalIdOf(value)
      const verdict = judgeRead(terminalId)
      if (!verdict.ok) {
        write({ id: idOf(value), ok: false, error: { code: verdict.code, message: verdict.message } })
        return
      }
    }
    // Noted before the call and answered after it: the subscription id only
    // exists once the handler has minted one, and it is the id the pane is
    // remembered under for as long as the teammate holds it.
    if (method === 'terminal.subscribe') {
      const terminalId = terminalIdOf(value)
      if (terminalId !== undefined) asked.set(idOf(value), terminalId)
    }
    if (method === 'unsubscribe') {
      const subscription = subscriptionOf(value)
      if (subscription !== undefined) releasing.add(subscription)
    }
    // The pane whose scrollback is about to be answered, so its own output can
    // be got out of the pacer first. Read here rather than in the continuation
    // because that is where the method is still known.
    const reading = method === 'terminal.read' ? terminalIdOf(value) : undefined
    void options.dispatch(value, { connectionId: options.connectionId }).then(
      (response) => {
        recordWatch(response)
        if (reading !== undefined) flushPane(reading)
        write(response)
      },
      (error: unknown) => {
        options.onError?.(error)
      }
    )
  }

  /**
   * Whether one keystroke may reach a pane, and nothing else.
   *
   * Everything here is a refusal this transport can make on its own, in front
   * of the owner's own decision: a session that has never decrypted anything, a
   * request that is not shaped like a write, a write too large for the wire it
   * arrived on, and a transport with nobody to report the write to. The owner's
   * verdict is asked last, because it is the one that has to be freshest.
   */
  /**
   * The owner's verdict on a read, with the transport's own refusals in front:
   * a request that named no pane cannot be scoped to a project, and a transport
   * with nobody to ask must not answer for one.
   */
  const judgeRead = (terminalId: string | undefined): RemoteReadVerdict => {
    if (terminalId === undefined) {
      return { ok: false, code: ErrorCode.InvalidParams, message: 'no pane was named' }
    }
    const ask = options.onRemoteRead
    if (!ask) {
      return { ok: false, code: ErrorCode.NotFound, message: 'this runtime is not sharing panes' }
    }
    return ask(terminalId)
  }

  const judgeWrite = (value: unknown): RemoteWriteVerdict => {
    // A replayed handshake reaches `established` holding somebody's key and can
    // never produce a transport message. Nothing can arrive here without having
    // decrypted, so this is already true — and it is asserted rather than
    // assumed, because "typing was possible before the keys were confirmed" is
    // not a sentence anybody should have to reconstruct from the call graph.
    if (!confirmed) {
      return { ok: false, code: ErrorCode.NotFound, message: 'this session is not confirmed' }
    }
    const terminalId = terminalIdOf(value)
    const data = paramOf(value, 'data')
    if (terminalId === undefined || data === undefined) {
      return { ok: false, code: ErrorCode.InvalidParams, message: 'a write needs a terminal and some data' }
    }
    const bytes = byteLength(data)
    if (bytes > MAX_REMOTE_WRITE_BYTES) {
      return {
        ok: false,
        code: ErrorCode.InvalidParams,
        message: `${bytes} bytes is more than one keystroke may carry (${MAX_REMOTE_WRITE_BYTES})`
      }
    }
    const judge = options.onRemoteWrite
    // Not a fallback to "allow". A transport wired without a verdict has no way
    // to attribute or record what it is about to run, and typing into a pane
    // unattributably is exactly what this milestone exists to prevent.
    if (!judge) {
      return { ok: false, code: ErrorCode.UnknownMethod, message: 'this runtime is not accepting remote keystrokes' }
    }
    return judge({ terminalId, data, bytes })
  }

  /** Files the subscription a `terminal.subscribe` answered with under its pane. */
  const recordWatch = (response: Frame): void => {
    const id = idOf(response)
    const terminalId = asked.get(id)
    if (terminalId === undefined) return
    asked.delete(id)
    if (!('ok' in response) || response.ok !== true) return
    const subscription = (response.result as { subscription?: unknown } | undefined)?.subscription
    if (typeof subscription !== 'string') return
    watching.set(subscription, terminalId)
    announceWatches()
  }

  const ask = <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<Answered<M>> => {
    if (!live) return Promise.reject(new Error('the peer link is closed'))
    nextId += 1
    const id = `peer_${nextId}`
    return new Promise<Answered<M>>((resolve, reject) => {
      // Armed before the frame is written, because `write` can fail the whole
      // transport in place and the cleanup that does must find this waiter
      // already holding its own cancel.
      const cancel = scheduler.setTimer(() => {
        if (!pending.delete(id)) return
        // Named, and named as silence rather than as a refusal: the far end has
        // not said no, it has said nothing, and the person who typed is owed
        // the difference.
        reject(
          new Error(`your teammate’s machine did not answer ${method} within ${PEER_CALL_TIMEOUT_MS / 1000} seconds`)
        )
      }, PEER_CALL_TIMEOUT_MS)
      pending.set(id, { resolve: resolve as (answer: never) => void, reject, cancel })
      write({ id, method, params } as unknown as Frame)
    })
  }

  return {
    call: <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> =>
      ask(method, params).then((answer) => answer.result),

    callInOrder: ask,

    receive: (message) => {
      if (!live) return
      let values: unknown[]
      try {
        values = reader.push(message)
        // After the decrypt, before anything is acted on: whatever is in this
        // message, the fact that it authenticated is the interesting part.
        // Recorded for every message and not only the first, because this
        // number is the link's whole evidence that somebody is still there and
        // it is worth exactly as much as it is fresh. A keepalive counts: it
        // carries an empty line that the decoder drops, and the decrypt that
        // produced it is the proof.
        decryptedAt = scheduler.now()
        if (!confirmed) {
          confirmed = true
          options.onConfirmed?.()
        }
      } catch (error) {
        // A Noise message that fails to authenticate and a line that is not
        // JSON are the same kind of event: the stream's position is gone and
        // there is no point from which it could be picked up again.
        fail(messageOf(error))
        return
      }
      for (const value of values) {
        // Re-checked every turn, because confirming the keys can itself end the
        // link: a session that authenticated a different key than the one this
        // side dialled is torn down inside `onConfirmed`, in the middle of this
        // message. Whatever else that message was carrying arrived over a
        // session this machine has just refused, and a keystroke in it must not
        // be run merely because the loop had already started.
        if (!live) return
        received += 1
        if (isResponse(value)) handleResponse(value, received)
        else if (isStreamFrame(value)) options.onStreamEvent?.(value.stream, value.event, received)
        else handleRequest(value)
      }
    },

    keepalive: () => {
      if (!live) return
      try {
        for (const message of encodeLine(options.session, '\n')) options.send(message)
      } catch (error) {
        fail(messageOf(error))
      }
    },

    get lastDecryptedAt() {
      return decryptedAt
    },

    close: (reason) => fail(reason)
  }
}

/** An error the *peer's* runtime returned, with its code preserved. */
export class PeerCallError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'PeerCallError'
    this.code = code
  }
}

/** One pane's output on its way out, and whatever has queued behind it. */
type PacedStream = {
  items: PacedItem[]
  bytes: number
  /** Output dropped because the buffer filled, still owed to the watcher. */
  lost: number
  /** When this stream last flushed, so a quiet pane is not made to wait. */
  at: number
  cancel: (() => void) | undefined
}

type PacedItem = { kind: 'data'; data: string; bytes: number } | { kind: 'event'; event: unknown }

const realScheduler: TransportScheduler = {
  now: () => Date.now(),
  setTimer: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    // A pending flush must never be the reason a process stays alive.
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

/**
 * The output one stream frame stands for, in bytes.
 *
 * A `data` event is worth what it carries and an `elided` is worth what it says
 * went missing, because both describe bytes the pane printed — the difference
 * between them is only whether the wire had room for them. Everything else is a
 * fact rather than a volume and is worth nothing: an exit is not output.
 *
 * Exported because two readers downstream have to weigh a run of frames against
 * a scrollback that may or may not still hold the same bytes, and a second
 * opinion about what counts as output is a second answer to the same question.
 */
export function outputBytes(event: unknown): number {
  const data = outputOf(event)
  if (data !== undefined) return byteLength(data)
  if (typeof event !== 'object' || event === null) return 0
  const record = event as { type?: unknown; bytes?: unknown }
  if (record.type !== 'elided' || typeof record.bytes !== 'number') return 0
  return Number.isFinite(record.bytes) ? Math.max(0, Math.trunc(record.bytes)) : 0
}

/** The payload of a `data` event, or undefined for anything that is not one. */
function outputOf(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as { type?: unknown; data?: unknown }
  return record.type === 'data' && typeof record.data === 'string' ? record.data : undefined
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Turns a byte count back into a character count when a chunk has to be cut in
 * the middle. Terminal output is overwhelmingly ASCII, so this is 1 almost
 * always; where it is not the cut lands near enough, and what the watcher is
 * told about is the real byte length of what was kept either way.
 */
function averageBytesPerChar(item: { data: string; bytes: number }): number {
  return item.data.length === 0 ? 1 : item.bytes / item.data.length
}

function subscriptionOf(value: unknown): string | undefined {
  return paramOf(value, 'subscription')
}

function terminalIdOf(value: unknown): string | undefined {
  return paramOf(value, 'terminalId')
}

function paramOf(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const params = (value as { params?: unknown }).params
  if (typeof params !== 'object' || params === null) return undefined
  const found = (params as Record<string, unknown>)[name]
  return typeof found === 'string' ? found : undefined
}

function isResponse(value: unknown): value is Response {
  return typeof value === 'object' && value !== null && 'ok' in value && 'id' in value
}

function isStreamFrame(value: unknown): value is { stream: string; event: unknown } {
  return typeof value === 'object' && value !== null && isStreamEvent(value as Frame)
}

function methodOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const method = (value as { method?: unknown }).method
  return typeof method === 'string' ? method : undefined
}

function idOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
