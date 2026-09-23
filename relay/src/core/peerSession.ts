// One peer's state machine and limits, written against a `PeerSocket` port so
// any host inherits every rule. The payload is read for its length and nothing
// else; `partner.deliver(payload)` in `onBinary` is the only place it goes.

import type { Clock } from './clock.js'
import type { RelayConfig } from './config.js'
import type { Logger } from './log.js'
import { CloseCode, encodeControl, parseHello, PING_FRAME, PONG_FRAME, type ControlFrame } from './protocol.js'
import { createTokenBucket, type BucketState, type TokenBucket } from './rateLimit.js'
import type { Peer, Rendezvous } from './rendezvous.js'

/** Everything the state machine needs from whatever is carrying the bytes. */
export type PeerSocket = {
  isOpen: () => boolean
  sendText: (text: string) => void
  sendBinary: (payload: Uint8Array) => void
  /** Bytes handed to the socket that the peer has not taken off it yet. */
  backlog: () => number
  /** A closing handshake with a code and a reason. */
  close: (code: number, reason: string) => void
  /** No handshake. For a peer that has already stopped answering. */
  terminate: () => void
  /** A WebSocket-protocol ping, or null where the host detects dead sockets itself and core leaves liveness alone. */
  ping: (() => void) | null
}

export type SessionHost = {
  config: RelayConfig
  clock: Clock
  log: Logger
  rendezvous: Rendezvous
  onClosed: (session: PeerSession) => void
}

export type SessionState = 'greeting' | 'waiting' | 'paired' | 'closed'

/** Everything a session is, as plain data, so a host evicted between frames can rebuild it. */
export type SessionSnapshot = {
  id: string
  origin: string
  openedAt: number
  token: string | null
  pairRef: string | null
  sessionId: string | null
  state: SessionState
  lastSpliceAt: number
  lastHeardAt: number
  lastPingAt: number
  awaitingPong: boolean
  framesIn: number
  framesOut: number
  frameBudget: BucketState
  byteBudget: BucketState
}

export class PeerSession implements Peer {
  readonly id: string
  /** Whatever the host uses to group connections. Opaque here. */
  readonly origin: string
  readonly openedAt: number

  private readonly socket: PeerSocket
  private readonly host: SessionHost
  private readonly frameBudget: TokenBucket
  private readonly byteBudget: TokenBucket

  private state: SessionState
  private token: string | null
  private pairRef: string | null
  private sessionId: string | null
  /** Last spliced content frame, in either direction. Drives the idle deadline. */
  private lastSpliceAt: number
  /** Last sign of life of any kind, including pongs. Drives the keepalive. */
  private lastHeardAt: number
  private awaitingPong: boolean
  private lastPingAt: number
  private framesIn: number
  private framesOut: number

  constructor(id: string, origin: string, socket: PeerSocket, host: SessionHost, restore?: SessionSnapshot) {
    this.id = id
    this.origin = origin
    this.socket = socket
    this.host = host
    this.openedAt = restore?.openedAt ?? host.clock.now()
    this.token = restore?.token ?? null
    this.pairRef = restore?.pairRef ?? null
    this.sessionId = restore?.sessionId ?? null
    this.state = restore?.state ?? 'greeting'
    this.lastSpliceAt = restore?.lastSpliceAt ?? this.openedAt
    this.lastHeardAt = restore?.lastHeardAt ?? this.openedAt
    this.lastPingAt = restore?.lastPingAt ?? 0
    this.awaitingPong = restore?.awaitingPong ?? false
    this.framesIn = restore?.framesIn ?? 0
    this.framesOut = restore?.framesOut ?? 0
    this.frameBudget = createTokenBucket(
      host.config.maxFramesPerSecond,
      host.config.maxFramesPerSecond,
      this.openedAt,
      restore?.frameBudget
    )
    this.byteBudget = createTokenBucket(
      host.config.maxBytesPerSecond,
      host.config.maxBytesPerSecond,
      this.openedAt,
      restore?.byteBudget
    )
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      origin: this.origin,
      openedAt: this.openedAt,
      token: this.token,
      pairRef: this.pairRef,
      sessionId: this.sessionId,
      state: this.state,
      lastSpliceAt: this.lastSpliceAt,
      lastHeardAt: this.lastHeardAt,
      lastPingAt: this.lastPingAt,
      awaitingPong: this.awaitingPong,
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      frameBudget: this.frameBudget.state(),
      byteBudget: this.byteBudget.state()
    }
  }

  get currentState(): SessionState {
    return this.state
  }

  get pairReference(): string | null {
    return this.pairRef
  }

  onText(text: string): void {
    if (this.state === 'closed') return
    const now = this.host.clock.now()
    this.lastHeardAt = now

    // The hello is the one uncharged frame, safe because there is only ever one:
    // `onHello` closes the connection or moves it out of `greeting`.
    if (this.state === 'greeting') {
      this.onHello(text)
      return
    }

    // Control frames cost the same event loop as content, so they are charged
    // before being looked at, as in `onBinary`. The O(1) frame token goes first:
    // an oversized frame should not buy a scan of itself from a peer over budget.
    if (!this.frameBudget.take(1, now)) {
      this.close(CloseCode.RateLimited, 'over the per-connection frame or byte budget')
      return
    }
    const bytes = utf8Length(text)
    if (bytes > this.host.config.maxFrameBytes) {
      this.close(CloseCode.TooLarge, 'frame over the size cap')
      return
    }
    if (!this.byteBudget.take(bytes, now)) {
      this.close(CloseCode.RateLimited, 'over the per-connection frame or byte budget')
      return
    }

    if (text === PING_FRAME) {
      // The pong is the relay's own write, so the buffer bound applies; a peer not
      // reading its own pongs is the one case nothing else measures.
      if (this.socket.backlog() > this.host.config.maxBufferedBytes) {
        this.host.log.warn('peer.slow', { conn: this.id, pair: this.pairRef ?? undefined })
        this.close(CloseCode.SlowConsumer, 'not reading fast enough to stay spliced')
        return
      }
      this.socket.sendText(PONG_FRAME)
      return
    }

    // Control is text and content is binary, both directions, no exceptions.
    this.close(CloseCode.Protocol, 'text frame after hello')
  }

  onBinary(payload: Uint8Array): void {
    if (this.state === 'closed') return
    const now = this.host.clock.now()
    this.lastHeardAt = now

    if (this.state === 'greeting') {
      this.close(CloseCode.Protocol, 'binary frame before hello')
      return
    }

    // Enforced here as well as by the host's parser, so the cap is the relay's, not the library's.
    if (payload.byteLength > this.host.config.maxFrameBytes) {
      this.close(CloseCode.TooLarge, 'frame over the size cap')
      return
    }

    // Budgets protect the relay, so they are checked before anything that costs it work.
    if (!this.frameBudget.take(1, now) || !this.byteBudget.take(payload.byteLength, now)) {
      this.close(CloseCode.RateLimited, 'over the per-connection frame or byte budget')
      return
    }

    if (this.state !== 'paired') {
      this.close(CloseCode.Protocol, 'content frame before pairing')
      return
    }

    const partner = this.host.rendezvous.partnerOf(this)
    if (partner === undefined) {
      // Paired by its own account, not by the table: the relay lost state (a
      // socket unreadable for one event is rebuilt without). Told to go away and
      // come back; a protocol complaint reads as the client's own bug and stops retries.
      this.host.log.warn('session.lost', { conn: this.id, pair: this.pairRef ?? undefined })
      this.close(CloseCode.GoingAway, 'the relay lost this session; reconnect')
      return
    }

    // The bound that keeps this a pipe, not a queue: past it the peer that stopped
    // reading is closed, since a Noise stream with a hole in it is over anyway.
    if (partner.backlog() > this.host.config.maxBufferedBytes) {
      this.host.log.warn('peer.slow', { conn: partner.id, pair: this.pairRef ?? undefined })
      partner.close(CloseCode.SlowConsumer, 'not reading fast enough to stay spliced')
      return
    }

    this.framesIn += 1
    this.lastSpliceAt = now
    partner.deliver(payload)
  }

  onPong(): void {
    this.awaitingPong = false
    this.lastHeardAt = this.host.clock.now()
  }

  /** A sign of life the host saw without core being given a frame: the Durable Object runtime answers keepalives itself. */
  noteHeard(at: number): void {
    if (at > this.lastHeardAt) this.lastHeardAt = at
  }

  /** The socket ended, for any reason, including one of this object's own. */
  onSocketClosed(code: number): void {
    const wasOpen = this.state !== 'closed'
    this.state = 'closed'
    if (wasOpen) this.releaseRendezvous()
    this.host.log.info('connection.closed', {
      conn: this.id,
      pair: this.pairRef ?? undefined,
      session: this.sessionId ?? undefined,
      code,
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      ageMs: this.host.clock.now() - this.openedAt
    })
    this.host.onClosed(this)
  }

  deliver(payload: Uint8Array): void {
    if (!this.socket.isOpen()) return
    this.framesOut += 1
    this.lastSpliceAt = this.host.clock.now()
    this.socket.sendBinary(payload)
  }

  backlog(): number {
    return this.socket.backlog()
  }

  markPaired(sessionId: string, initiator: boolean): void {
    this.state = 'paired'
    this.sessionId = sessionId
    this.lastSpliceAt = this.host.clock.now()
    this.notify({ t: 'paired', session: sessionId, initiator })
  }

  notify(frame: ControlFrame): void {
    if (!this.socket.isOpen()) return
    this.socket.sendText(encodeControl(frame))
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.socket.isOpen()) {
      // In-band too: close reasons are capped at 123 bytes and some clients never surface them.
      this.notify({ t: 'closing', code, reason })
      this.socket.close(code, reason.slice(0, 100))
    } else {
      this.socket.terminate()
    }
    this.releaseRendezvous()
  }

  /** Keepalive and deadlines, driven by one sweep across all connections rather than a timer each. */
  sweep(now: number): void {
    if (this.state === 'closed') return
    const { config } = this.host

    // Opening and saying nothing is the cheapest way to hold a slot, so the tightest deadline.
    if (this.state === 'greeting' && now - this.openedAt >= config.helloTimeoutMs) {
      this.close(CloseCode.BadHello, 'no hello within the greeting deadline')
      return
    }

    // Idle counts keepalives as life: content alone would hang up on a pair
    // keeping itself alive exactly the way this relay documents.
    const quietSince = Math.max(this.lastSpliceAt, this.lastHeardAt)
    if (this.state === 'paired' && config.idleTimeoutMs > 0 && now - quietSince >= config.idleTimeoutMs) {
      this.endForSilence()
      return
    }

    // Liveness is only core's business where the host gave it a ping to send.
    const ping = this.socket.ping
    if (ping === null) return

    // Anything heard within the interval is proof of life, so a repeat sweep at
    // the same instant is a no-op; deadlines can be driven one step at a time.
    if (now - this.lastHeardAt < config.keepaliveIntervalMs) return

    if (this.awaitingPong) {
      if (now - this.lastPingAt < config.keepaliveIntervalMs) return
      // A NAT that forgot the mapping leaves a socket that looks open and never speaks again.
      this.host.log.info('peer.unresponsive', { conn: this.id, pair: this.pairRef ?? undefined })
      this.state = 'closed'
      this.socket.terminate()
      this.releaseRendezvous()
      return
    }

    if (this.socket.isOpen()) {
      this.awaitingPong = true
      this.lastPingAt = now
      ping()
    }
  }

  // Both halves hear the same true thing; closing one alone would have `leave`
  // tell the other its partner disconnected, and nothing did.
  private endForSilence(): void {
    const reason = 'no sign of life on this session within the idle budget'
    if (this.token !== null && this.host.rendezvous.endSession(this.token, this, CloseCode.Idle, reason)) return
    this.close(CloseCode.Idle, reason)
  }

  private onHello(text: string): void {
    const parsed = parseHello(text)
    if (!parsed.ok) {
      this.close(CloseCode.BadHello, parsed.reason)
      return
    }

    const { rendezvous } = parsed.hello
    this.token = rendezvous
    const outcome = this.host.rendezvous.join(rendezvous, this, this.host.clock.now())
    this.pairRef = outcome.pairRef

    if (outcome.status === 'waiting') {
      this.state = 'waiting'
      this.notify({ t: 'waiting' })
      this.host.log.info('peer.waiting', {
        conn: this.id,
        pair: outcome.pairRef,
        superseded: outcome.supersededSession || undefined
      })
      return
    }

    // State and session id were set by `markPaired` from inside `join`, for both halves.
    this.host.log.info('session.opened', { conn: this.id, pair: outcome.pairRef, session: outcome.sessionId })
  }

  private releaseRendezvous(): void {
    if (this.token === null) return
    this.host.rendezvous.leave(this.token, this)
  }
}

// Wire bytes of a text frame without allocating a copy. Frames arrive validated
// as UTF-8, so a high surrogate here is always the first half of a pair.
function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}
