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
// teammate. `docs/teamwork.md` means for a teammate to see panes and eventually
// to type into one, and it does not mean for them to remove a worktree or drop
// a project. So a peer's reachable surface is an explicit allow-list, and it is
// the seam the later milestones widen: C has added the two reads that stream a
// pane's output, D adds `terminal.write`. Everything absent from the set
// answers as an unknown method, which is what it is from where the peer stands.
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

import type { MethodName, ParamsOf, ResultOf } from '../../shared/methods'
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
 * What a teammate may ask this runtime to do, in milestone C.
 *
 * Presence, and the two reads that let somebody watch a pane: `terminal.read`
 * for the scrollback they are joining, `terminal.subscribe` for everything
 * after it. Both are reads. `terminal.write` is milestone D and its absence
 * here is the whole of what makes watching read-only — a watcher's keystrokes
 * reach a method this runtime answers as one it has never heard of.
 *
 * Adding a method here is the deliberate act of handing a teammate a new
 * capability, so the set is spelled out rather than derived.
 */
export const PEER_METHODS: readonly MethodName[] = [
  'peer.presence',
  'peer.subscribe',
  'terminal.read',
  'terminal.subscribe',
  'unsubscribe'
] as const

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
  /** Stream frames the *peer* pushed to us, for a subscription we opened there. */
  onStreamEvent?: (stream: string, event: unknown) => void
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

export type PeerTransport = {
  /** A request to the peer, typed from the same catalogue. */
  call: <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>
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
  /** Fails every call still in flight and releases this peer's subscriptions. */
  close: (reason: string) => void
}

export function createPeerTransport(options: PeerTransportOptions): PeerTransport {
  const allowed = new Set<string>(options.allowedMethods ?? PEER_METHODS)
  const pending = new Map<string, { resolve: (value: never) => void; reject: (error: Error) => void }>()
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
  let live = true
  let confirmed = false

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
    for (const [, waiter] of pending) waiter.reject(new Error(reason))
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

  const flush = (streamId: string, stream: PacedStream): void => {
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
      if (item.bytes > budget) break
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

  const handleResponse = (response: Response): void => {
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    if (response.ok) waiter.resolve(response.result as never)
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
    void options.dispatch(value, { connectionId: options.connectionId }).then(
      (response) => {
        recordWatch(response)
        write(response)
      },
      (error: unknown) => {
        options.onError?.(error)
      }
    )
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

  return {
    call: <M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => {
      if (!live) return Promise.reject(new Error('the peer link is closed'))
      nextId += 1
      const id = `peer_${nextId}`
      return new Promise<ResultOf<M>>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject })
        write({ id, method, params } as unknown as Frame)
      })
    },

    receive: (message) => {
      if (!live) return
      let values: unknown[]
      try {
        values = reader.push(message)
        // After the decrypt, before anything is acted on: whatever is in this
        // message, the fact that it authenticated is the interesting part.
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
        if (isResponse(value)) handleResponse(value)
        else if (isStreamFrame(value)) options.onStreamEvent?.(value.stream, value.event)
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
