// A teammate's way into the runtime, the same shape as `socketServer.ts`: the bytes
// are Noise-encrypted (`peerFraming.ts`), the reachable catalogue is the allow-list
// `PEER_METHODS`, and `terminal.write` passes `onRemoteWrite` before it is dispatched.

import { CONSENT_WINDOW_MS } from '../../shared/entities'
import {
  MAX_REMOTE_WRITE_BYTES,
  MAX_TERMINAL_ID_CHARS,
  type MethodName,
  type ParamsOf,
  type ResultOf
} from '../../shared/methods'
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
import { defaultMonotonicNow, startTimedWindow } from './elapsed'
import { createLineReader, encodeLine } from './peerFraming'
import type { SubscriptionHub } from './subscriptionHub'

/**
 * What has to be true about the caller before one admitted method runs. The list
 * is the table of scopes, so a method cannot be admitted without naming one:
 * `link` needs nothing, `read-pane` asks the owner whether this teammate may look,
 * `write-pane` runs code and is judged separately from looking.
 */
export type PeerScope = 'link' | 'read-pane' | 'write-pane'

/**
 * What a teammate may ask this runtime to do. `terminal.resize` and `terminal.close`
 * stay absent (a teammate's window is not this pane's window), and everything
 * touching git is absent — "anyone can type" is about panes, not worktrees.
 */
export const PEER_METHODS: Readonly<Partial<Record<MethodName, PeerScope>>> = {
  'peer.presence': 'link',
  'peer.subscribe': 'link',
  unsubscribe: 'link',
  'terminal.read': 'read-pane',
  'terminal.subscribe': 'read-pane',
  'terminal.write': 'write-pane'
} as const

/**
 * How long a call to the teammate may go unanswered. Every method on `PEER_METHODS`
 * is answered out of memory, so thirty seconds is no answer; `peerLink.ts`'s silence deadline is the longer backstop.
 */
export const PEER_CALL_TIMEOUT_MS = 30_000

/**
 * The same, for the one method whose answer may be a person's. Derived from the
 * consent window so the machine doing the typing is always more patient than the
 * machine doing the deciding; otherwise the owner's "yes" lands on a request already given up on.
 */
export const PEER_WRITE_TIMEOUT_MS = CONSENT_WINDOW_MS + PEER_CALL_TIMEOUT_MS

/**
 * How long output for one pane is gathered before it is sent: fifty flushes a
 * second against the relay's 200 frames, under what a reader calls laggy. A quiet pane pays none of it.
 */
export const STREAM_FLUSH_MS = 20

/**
 * The share of the relay's 4 MiB/s one connection's terminal output may take. A
 * quarter: a link carries several panes, and a budget spent exactly gets the connection closed.
 */
export const STREAM_BYTES_PER_SECOND = 1_048_576

/**
 * How much of a pane's output may wait for the wire before the head is dropped: one
 * relay frame. The watcher wants the tail.
 */
export const STREAM_BUFFER_BYTES = 262_144

/** One keystroke a teammate sent, before anything has been decided about it. */
export type RemoteWriteRequest = {
  terminalId: string
  data: string
  /** Counted once, here, because every decision below is about size. */
  bytes: number
}

/** What the owner's machine decided about one keystroke. A refusal carries the words the teammate is given. */
export type RemoteWriteDecision = { ok: true } | { ok: false; code: ErrorCode; message: string }

/**
 * A decision, or the promise of one. `held` means a person is being asked: not
 * refused, not running, the bytes in the owner's memory. The promise settling is
 * the ONLY thing that can put a held keystroke in front of the dispatcher.
 */
export type RemoteWriteVerdict = RemoteWriteDecision | { held: Promise<RemoteWriteDecision> }

/**
 * What the owner's machine decided about one read. A separate name from a write's
 * verdict, so one call site cannot be wired to the other's judge.
 */
export type RemoteReadVerdict = { ok: true } | { ok: false; code: ErrorCode; message: string }

/**
 * How many streams one teammate may hold open at once. Nobody reads thirty panes;
 * every record past that is a pacing buffer kept on somebody else's say-so.
 */
export const MAX_PEER_SUBSCRIPTIONS = 32

/**
 * What a reader is told when the pane is no longer there. One sentence down two
 * paths that must not disagree: the stream ending here, and `PeerService.remoteRead` refusing a read that raced the close.
 */
export const PANE_CLOSED = 'the owner closed this pane'

/** The methods on the allow-list that leave a subscription behind. Spelled out, as `PEER_METHODS` is. */
const SUBSCRIBING_METHODS: readonly MethodName[] = ['peer.subscribe', 'terminal.subscribe'] as const

/**
 * How many requests a second one teammate may ask for, and how many at once. A
 * frame is not a request: one Noise message carries some nine hundred `unsubscribe`s,
 * and every request is work on the owner's main thread. The burst is what a watcher joining does in one breath.
 */
export const PEER_REQUEST_BURST = 200
export const PEER_REQUESTS_PER_SECOND = 100

/**
 * The same, for the one method that runs code: a key held down repeats at thirty
 * a second. Spent as well as the request bucket, never instead. A write refused here
 * never reaches `onRemoteWrite`, so a flood is not recorded in the owner's audit log.
 */
export const PEER_WRITE_BURST = 100
export const PEER_WRITES_PER_SECOND = 50

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
  /** Stream frames the *peer* pushed to us. `sequence` is the frame's place in the received order; see `received`. */
  onStreamEvent?: (stream: string, event: unknown, sequence: number) => void
  /**
   * Which of this machine's panes the teammate has open, whenever that changes. Observed
   * here because this is the only place that knows a caller is a teammate at all.
   */
  onWatchChange?: (terminalIds: readonly string[]) => void
  /**
   * Asked about every keystroke before it reaches a pane; the only layer that can
   * attribute, record or refuse a write. Synchronous on purpose, so a mute applied
   * mid-flight lands on that keystroke. **A transport without this refuses every write.**
   */
  onRemoteWrite?: (write: RemoteWriteRequest) => RemoteWriteVerdict
  /**
   * Whether this teammate may read that pane. A transport wired without one carries
   * no reads at all: one that forgot to ask would stream every pane on the machine.
   */
  onRemoteRead?: (terminalId: string) => RemoteReadVerdict
  /** Timers and the clock, so the pacing is driven rather than slept through. */
  scheduler?: TransportScheduler
  /**
   * Called once, on the first transport message that decrypts: key confirmation, which
   * is not the handshake completing. A replayer with a captured message 1 reaches
   * `established` carrying the real peer's static key but can never produce a transport message.
   */
  onConfirmed?: () => void
  /**
   * The link can no longer be trusted: a Noise failure or a frame that is not JSON,
   * neither recoverable. Not called for a `close` the owner asked for.
   */
  onFatal: (failure: TransportFailure) => void
  /** Failures that cost one call and not the link. */
  onError?: (error: unknown) => void
}

/**
 * Why a transport gave up. `unauthenticated`: a frame did not open under the session
 * keys, so what arrived is not what was sent — a fact about the trip. `local`: this
 * side's own session refusing to encrypt. The caller puts a sentence on a screen about one machine or the other.
 */
export type TransportFailure = {
  reason: string
  kind: 'unauthenticated' | 'local'
}

/** The sliver of a clock the outbound pacing and the deadlines need. */
export type TransportScheduler = {
  now: () => number
  /** Returns the cancel for the timer it set. */
  setTimer: (run: () => void, delayMs: number) => () => void
  /**
   * A clock a sleeping machine cannot move. Defaults to `performance.now()`; a peer's
   * silence is measured against this because the wall clock jumps by the length of a closed lid.
   */
  monotonicNow?: () => number
}

/** An answer from the peer, and the position of the frame that carried it. */
export type Answered<M extends MethodName> = { result: ResultOf<M>; sequence: number }

export type PeerTransport = {
  /** A request to the peer, typed from the same catalogue. */
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
  /**
   * The same request, and where the answer sat in the received order. A promise settles
   * in a later task than the one that read its frame, after frames behind it were routed.
   */
  callInOrder: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<Answered<M>>
  /** One Noise transport message, exactly as the peer framed it. */
  receive: (message: Uint8Array) => void
  /**
   * A content frame carrying nothing. The relay's idle deadline counts content frames
   * only — a text ping does not reset it — and an empty line is the cheapest legal frame.
   */
  keepalive: () => void
  /**
   * How long since this session last decrypted something from the peer, on a clock a
   * sleeping machine cannot move. The only honest evidence anybody is there; an open socket is not.
   */
  readonly quietForMs: number
  /** Fails every call still in flight and releases this peer's subscriptions. */
  close: (reason: string) => void
}

export function createPeerTransport(options: PeerTransportOptions): PeerTransport {
  const scopes: Readonly<Partial<Record<MethodName, PeerScope>>> =
    options.allowedMethods === undefined
      ? PEER_METHODS
      : Object.fromEntries(options.allowedMethods.map((method) => [method, PEER_METHODS[method] ?? 'link']))
  /** The scope this method runs under, or nothing at all when it is not admitted. */
  const scopeOf = (method: string | undefined): PeerScope | undefined =>
    method === undefined ? undefined : scopes[method as MethodName]
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
  /**
   * Subscriptions the peer itself asked to end, so its goodbye is not echoed. Only ids
   * this link holds reach it (see `ours`): a set fed from the wire is sized by the other end.
   */
  const releasing = new Set<string>()
  /**
   * Subscription ids the hub minted for this link and has not ended. `reserved` is
   * promised and not yet minted: a slot is taken at the check, so a burst in one frame cannot all read the same count.
   */
  const ours = new Set<string>()
  /** Subscriptions that ended before the answer naming them came back, so that answer releases the slot rather than leaking it. */
  const endedEarly = new Set<string>()
  let reserved = 0
  const paced = new Map<string, PacedStream>()
  /** What a teammate may ask for, refilled by time and spent by asking. */
  const requests = createBucket(PEER_REQUEST_BURST, PEER_REQUESTS_PER_SECOND, scheduler)
  const writes = createBucket(PEER_WRITE_BURST, PEER_WRITES_PER_SECOND, scheduler)
  /** One second's worth of bytes, spent by flushes and refilled by time. */
  let budget = STREAM_BYTES_PER_SECOND
  let budgetAt = scheduler.now()
  let nextId = 0
  /**
   * Frames read off this session, counted: the only clock that says which of two frames
   * came first. `receive` routes a batch synchronously, so a stream frame decoded after
   * an answer still reaches its route before the answer's promise continuation runs.
   */
  let received = 0
  let live = true
  let confirmed = false
  /** Starts at construction, so a session that has said nothing reads as quiet for no time; the handshake window is `peerLink.ts`'s to police. */
  let quiet = startTimedWindow(scheduler)

  const write = (frame: Frame): void => {
    if (!live) return
    try {
      for (const message of encodeLine(options.session, encodeFrame(frame))) options.send(message)
    } catch (error) {
      // Encryption only fails once the session is unusable; this side's own, so it
      // says nothing about the peer.
      fail(messageOf(error), 'local')
    }
  }

  /** Releases everything this transport holds. Silent: the caller asked, and a shutdown reported as a fault is wrong. */
  const release = (reason: string): void => {
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
  }

  /**
   * This transport is over and nobody asked. `onError` is the operator's trace (a relay
   * quietly breaking every session looks like bad luck otherwise); `onFatal` is the link's cue to say which failure.
   */
  const fail = (reason: string, kind: TransportFailure['kind']): void => {
    if (!live) return
    release(reason)
    options.onError?.(new Error(reason))
    options.onFatal({ reason, kind })
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
   * One stream's waiting output, onto the wire. `force` spends past the byte budget;
   * only the answer to a `terminal.read` asks for it (see `flushPane`), and the debit still happens.
   */
  const flush = (streamId: string, stream: PacedStream, force = false): void => {
    if (!live) return
    const now = scheduler.now()
    refill(now)
    stream.at = now

    // Before the output it precedes: the bytes that went were in front of what is about to be sent.
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

    // The record stays when empty: it remembers when this stream last flushed, or every
    // chunk of a burst would go out on its own leading edge. Dropped with the subscription.
    if (stream.items.length === 0 && stream.lost === 0) return
    arm(streamId, stream)
  }

  /**
   * Everything one pane has waiting, out before the answer that describes it. The
   * scrollback is taken the moment the read is handled while output from a twentieth
   * of a second ago may still wait for its timer; a reader joining by frame order would
   * show it twice. Runs inside one turn, so it flushes exactly what the answer carries.
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
      // Only output can be thrown away; an exit or a title is a fact, not a volume.
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
   * Everything a subscription pushes. Only a pane's output is paced; once output is
   * waiting, its exit and title queue behind it so a pane never finishes before it speaks.
   */
  const publish = (frame: StreamEvent): void => {
    if (!live) return
    const existing = paced.get(frame.stream)
    const data = outputOf(frame.event)
    // Nothing is waiting, so nothing is held back.
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
      // Lossless: two consecutive chunks of one byte stream concatenate into the same stream.
      if (last !== undefined && last.kind === 'data') {
        last.data += data
        last.bytes += bytes
      } else {
        stream.items.push({ kind: 'data', data, bytes })
      }
      stream.bytes += bytes
      evict(stream)
    }

    // Leading edge: a quiet pane is sent the moment it speaks.
    if (!stream.cancel && scheduler.now() - stream.at >= STREAM_FLUSH_MS) flush(frame.stream, stream)
    else arm(frame.stream, stream)
  }

  // The peer gets its own subscription scope, so whatever it opened dies with the link.
  // Its end is reported back, so the owner stops being told somebody is reading.
  options.subscriptions.openConnection(options.connectionId, publish, (subscriptionId) => {
    const stream = paced.get(subscriptionId)
    if (stream) {
      stream.cancel?.()
      stream.cancel = undefined
      // Out before it is let go of, and forced. `session-manager.ts` ends a pane's
      // streams *before* it closes the session, so the pacer may hold a flush interval
      // of output plus the exit behind it. `live` is still true, so `elided` goes out first.
      flush(subscriptionId, stream, true)
      paced.delete(subscriptionId)
    }
    const asked = releasing.delete(subscriptionId)
    // The slot goes back when the subscription does. An id not on our books ended
    // before its own answer came back, and is remembered so that answer gives the slot back.
    if (!ours.delete(subscriptionId) && reserved > 0) noteEndedEarly(subscriptionId)
    if (!watching.delete(subscriptionId)) return
    announceWatches()
    // The owner closed the pane out from under a reader; nothing else would tell
    // them. A peer that ended its own subscription already knows.
    if (!asked) write({ stream: subscriptionId, event: { type: 'lost', reason: PANE_CLOSED } })
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
    const scope = scopeOf(method)
    if (method !== undefined && scope === undefined) {
      // Deliberately the same answer a method that does not exist gets.
      write({
        id: idOf(value),
        ok: false,
        error: { code: ErrorCode.UnknownMethod, message: `${method} is not a method a teammate can call` }
      })
      return
    }
    // Before anything is decided: a request is work on the owner's main thread, and a
    // frame is nine hundred of them. Answered rather than dropped, like every refusal here.
    if (!requests.spend()) {
      write({
        id: idOf(value),
        ok: false,
        error: {
          code: ErrorCode.Conflict,
          message: `this link may ask for ${PEER_REQUESTS_PER_SECOND} things a second; slow down and try again`
        }
      })
      return
    }
    // The slot is taken here, synchronously. The hub's count only moves inside the
    // handler, so a check that read it is one `await` away from being a cap on nothing.
    const subscribes = method !== undefined && subscribing.has(method)
    if (subscribes) {
      if (heldSubscriptions() >= MAX_PEER_SUBSCRIPTIONS) {
        // Answered with the reason, so a teammate that opened too many panes can close some.
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
      reserved += 1
    }
    const releaseReservation = (): void => {
      if (!subscribes) return
      reserved -= 1
    }

    /**
     * The request, once everything in front of it has let it past. A function because a
     * held keystroke runs it from a later task, with the same bookkeeping and dispatcher.
     */
    const run = (): void => {
      // Noted before the call and answered after it: the id only exists once the handler has minted one.
      if (method === 'terminal.subscribe') {
        const terminalId = terminalIdOf(value)
        if (terminalId !== undefined) asked.set(idOf(value), terminalId)
      }
      // Only for a subscription this link holds. An id from the wire naming a subscription
      // that did not exist *yet* was believed when it did, swallowing the owner's "I closed this pane".
      if (method === 'unsubscribe') {
        const subscription = subscriptionOf(value)
        if (subscription !== undefined && ours.has(subscription)) releasing.add(subscription)
      }
      // The pane whose scrollback is about to be answered, read here where the method is still known.
      const reading = method === 'terminal.read' ? terminalIdOf(value) : undefined
      void options.dispatch(value, { connectionId: options.connectionId }).then(
        (response) => {
          if (subscribes) settleReservation(response)
          recordWatch(response)
          if (reading !== undefined) flushPane(reading)
          write(response)
        },
        (error: unknown) => {
          releaseReservation()
          // Defensive: this runtime's dispatcher turns every throw into an error response.
          // The note above is only ever removed by an answer, so a rejection would leak one per call.
          asked.delete(idOf(value))
          options.onError?.(error)
        }
      )
    }

    if (scope === 'write-pane') {
      // The keystroke's own budget, on top of the request's; a flood is refused before a verdict, a pty, or the log.
      if (!writes.spend()) {
        releaseReservation()
        write({
          id: idOf(value),
          ok: false,
          error: {
            code: ErrorCode.Conflict,
            message: `this link may type ${PEER_WRITES_PER_SECOND} times a second; slow down and try again`
          }
        })
        return
      }
      const verdict = judgeWrite(value)
      // The owner is being asked; the bytes are in their memory, not this request. What
      // follows runs in a later task, and `live` is re-checked there.
      if ('held' in verdict) {
        void verdict.held.then(
          (decision) => {
            if (!live) return
            if (!decision.ok) {
              write({ id: idOf(value), ok: false, error: { code: decision.code, message: decision.message } })
              return
            }
            run()
          },
          (error: unknown) => {
            // Defensive: the service settles every held write with a decision. A promise that
            // broke anyway must still end as an answer.
            options.onError?.(error)
            if (!live) return
            write({
              id: idOf(value),
              ok: false,
              error: { code: ErrorCode.Internal, message: 'this keystroke was never decided, so it was not run' }
            })
          }
        )
        return
      }
      if (!verdict.ok) {
        write({ id: idOf(value), ok: false, error: { code: verdict.code, message: verdict.message } })
        return
      }
    }
    // Reading is scoped too: `terminal.read` and `terminal.subscribe` once went to the
    // dispatcher carrying only the id, so a teammate could stream a pane of a project they hold no key for.
    if (scope === 'read-pane') {
      const terminalId = terminalIdOf(value)
      const verdict = judgeRead(terminalId)
      if (!verdict.ok) {
        releaseReservation()
        write({ id: idOf(value), ok: false, error: { code: verdict.code, message: verdict.message } })
        return
      }
    }
    run()
  }

  /**
   * What this link holds, counted the way that cannot be raced: the maximum of reservations
   * plus our books and the hub's count, since a synchronous subscribe has moved the hub while its reservation is outstanding.
   */
  const heldSubscriptions = (): number =>
    Math.max(ours.size + reserved, options.subscriptions.countFor(options.connectionId))

  /** A reservation, once the answer says what became of it: a minted subscription takes the slot, anything else gives it up. */
  const settleReservation = (response: Frame): void => {
    reserved -= 1
    if (!('ok' in response) || response.ok !== true) return
    const subscription = (response.result as { subscription?: unknown } | undefined)?.subscription
    if (typeof subscription !== 'string') return
    if (endedEarly.delete(subscription)) return
    ours.add(subscription)
  }

  /** An id whose subscription ended before its answer came back. Bounded by what can be in flight. */
  const noteEndedEarly = (subscriptionId: string): void => {
    endedEarly.add(subscriptionId)
    while (endedEarly.size > reserved) {
      const oldest = endedEarly.values().next()
      if (oldest.done === true) return
      endedEarly.delete(oldest.value)
    }
  }

  /**
   * The owner's verdict on a read, with the transport's refusals in front: no pane
   * named, or nobody to ask.
   */
  const judgeRead = (terminalId: string | undefined): RemoteReadVerdict => {
    if (terminalId === undefined) {
      return { ok: false, code: ErrorCode.InvalidParams, message: 'no pane was named' }
    }
    // Here as well as in the schema, because this runs *before* the schema: the id is
    // kept in the watching map and handed to whoever is told who is reading.
    if (terminalId.length > MAX_TERMINAL_ID_CHARS) {
      return {
        ok: false,
        code: ErrorCode.InvalidParams,
        message: `a pane id may not be longer than ${MAX_TERMINAL_ID_CHARS} characters`
      }
    }
    const ask = options.onRemoteRead
    if (!ask) {
      return { ok: false, code: ErrorCode.NotFound, message: 'this runtime is not sharing panes' }
    }
    return ask(terminalId)
  }

  /** Whether one keystroke may reach a pane: the transport's own refusals, then the owner's verdict last, because it must be freshest. */
  const judgeWrite = (value: unknown): RemoteWriteVerdict => {
    // A replayed handshake reaches `established` and can never produce a transport message,
    // so this is already true; asserted so "typing before the keys were confirmed" needs no call graph.
    if (!confirmed) {
      return { ok: false, code: ErrorCode.NotFound, message: 'this session is not confirmed' }
    }
    const terminalId = terminalIdOf(value)
    const data = paramOf(value, 'data')
    if (terminalId === undefined || data === undefined) {
      return { ok: false, code: ErrorCode.InvalidParams, message: 'a write needs a terminal and some data' }
    }
    // Capped here as well as in the schema, because this runs *before* the schema and the
    // owner's verdict records the write whether or not it lands: an unbounded id is a megabyte in the audit log.
    if (terminalId.length > MAX_TERMINAL_ID_CHARS) {
      return {
        ok: false,
        code: ErrorCode.InvalidParams,
        message: `a pane id may not be longer than ${MAX_TERMINAL_ID_CHARS} characters`
      }
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
    // Not a fallback to "allow": a transport without a verdict cannot attribute or record what it runs.
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
    // A write may be waiting on a person, so it gets the owner's consent window on top.
    const deadlineMs = method === 'terminal.write' ? PEER_WRITE_TIMEOUT_MS : PEER_CALL_TIMEOUT_MS
    return new Promise<Answered<M>>((resolve, reject) => {
      // Armed before the frame is written, because `write` can fail the whole transport
      // in place and that cleanup must find this waiter holding its own cancel.
      const window = startTimedWindow(scheduler, deadlineMs)
      const cancel = scheduler.setTimer(() => {
        if (!pending.delete(id)) return
        // A deadline this side slept through is not evidence about the teammate. Still
        // settled — a promise nobody answers is the worse failure — with what happened.
        if (window.wasInterrupted()) {
          reject(new Error(`this machine was asleep, so ${method} was never given an answer`))
          return
        }
        // Named as silence rather than refusal: the far end said nothing, not no.
        reject(new Error(`your teammate’s machine did not answer ${method} within ${deadlineMs / 1000} seconds`))
      }, deadlineMs)
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
        // After the decrypt, before anything is acted on, for every message: this number is
        // the link's whole evidence somebody is there. A keepalive counts; the decrypt is the proof.
        quiet = startTimedWindow(scheduler)
        if (!confirmed) {
          confirmed = true
          options.onConfirmed?.()
        }
      } catch (error) {
        // A Noise message that fails to authenticate and a line that is not JSON are the same
        // event: the stream's position is gone, a fact about the trip and not either end.
        fail(messageOf(error), 'unauthenticated')
        return
      }
      for (const value of values) {
        // Re-checked every turn: confirming the keys can itself end the link inside
        // `onConfirmed`, and a keystroke in the same message must not run.
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
        fail(messageOf(error), 'local')
      }
    },

    get quietForMs() {
      return quiet.elapsedMs()
    },

    close: (reason) => release(reason)
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

/**
 * One link's allowance, refilled by time and spent by asking. A token bucket rather
 * than a counter per window, since a window boundary is a thing to aim at for double rate. Wall clock: a machine that slept comes back full.
 */
type Bucket = { spend: () => boolean }

function createBucket(capacity: number, perSecond: number, scheduler: TransportScheduler): Bucket {
  let tokens = capacity
  let at = scheduler.now()
  return {
    spend: () => {
      const now = scheduler.now()
      const earned = ((now - at) * perSecond) / 1000
      if (earned > 0) {
        tokens = Math.min(capacity, tokens + earned)
        at = now
      }
      if (tokens < 1) return false
      tokens -= 1
      return true
    }
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
  monotonicNow: defaultMonotonicNow,
  setTimer: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    // A pending flush must never be the reason a process stays alive.
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

/**
 * The output one stream frame stands for, in bytes: a `data` is what it carries, an
 * `elided` what it says went missing, anything else is a fact and worth nothing. Exported so downstream readers share one answer.
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
 * Byte count back to character count for a mid-chunk cut. Terminal output is
 * overwhelmingly ASCII, so this is 1 almost always.
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
