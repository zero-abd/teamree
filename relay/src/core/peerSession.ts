// One peer's state machine and its share of the limits, written against a socket
// port rather than a socket. Every rule the relay has about a single connection
// lives here, so a different host runtime supplies a `PeerSocket` and inherits
// all of it.
//
// The splice itself is four lines in `onBinary`, and that is on purpose: every
// other line in this file exists to decide whether those four lines run. The
// payload is read for its length and for nothing else — never parsed, never
// copied into a string, never logged. If you are auditing the claim that the
// relay cannot read content, `partner.deliver(payload)` is the only place a
// payload goes.

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
  /**
   * A WebSocket-protocol ping, or null where the host does not expose one. Null
   * means the host detects dead sockets itself and core leaves liveness alone;
   * peers can still drive the application-level ping in `protocol.ts`.
   */
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

/**
 * Everything a session is, as plain data. A host that is evicted from memory
 * between frames — which is the normal, cheap case for a pair that has been
 * quiet for hours — stores this beside the socket and builds the session back
 * from it, so none of the rules below have to know that happened.
 */
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
    this.lastHeardAt = this.host.clock.now()
    if (this.state !== 'greeting') {
      if (text === PING_FRAME) {
        this.socket.sendText(PONG_FRAME)
        return
      }
      // Otherwise: control is text and content is binary, in both directions and
      // with no exceptions. A peer sending anything else here is either a
      // different protocol or a confused one, and guessing which is not the
      // relay's job.
      this.close(CloseCode.Protocol, 'text frame after hello')
      return
    }
    this.onHello(text)
  }

  onBinary(payload: Uint8Array): void {
    if (this.state === 'closed') return
    const now = this.host.clock.now()
    this.lastHeardAt = now

    if (this.state === 'greeting') {
      this.close(CloseCode.Protocol, 'binary frame before hello')
      return
    }

    // Enforced here as well as by whatever parser the host uses, so the cap is a
    // property of the relay rather than of the library underneath it.
    if (payload.byteLength > this.host.config.maxFrameBytes) {
      this.close(CloseCode.TooLarge, 'frame over the size cap')
      return
    }

    // Budgets next: they protect the relay, so they are checked before anything
    // that costs it work.
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
      this.close(CloseCode.Protocol, 'no partner for a paired connection')
      return
    }

    // The bound that keeps this a pipe rather than a queue. Past it the relay
    // does not buffer, does not silently drop frames and does not slow the
    // sender down: it closes the peer that stopped reading and lets the pair
    // rebuild, because a Noise stream with a hole in it is over anyway.
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

  /**
   * A sign of life the host saw without core being given a frame for it. The
   * Durable Object host needs this and the container host does not: there the
   * runtime answers a peer's keepalive on the object's behalf, without waking
   * it, so a timestamp read back afterwards is the only evidence the peer left.
   */
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
      // Said in-band as well as in the close frame: close reasons are capped at
      // 123 bytes on the wire and some clients never surface them at all.
      this.notify({ t: 'closing', code, reason })
      this.socket.close(code, reason.slice(0, 100))
    } else {
      this.socket.terminate()
    }
    this.releaseRendezvous()
  }

  /**
   * Keepalive and deadline enforcement, driven by one sweep across all
   * connections rather than by a timer per connection.
   */
  sweep(now: number): void {
    if (this.state === 'closed') return
    const { config } = this.host

    // A connection that opens and says nothing is the cheapest way to hold a
    // slot, so the greeting has the tightest deadline of anything here.
    if (this.state === 'greeting' && now - this.openedAt >= config.helloTimeoutMs) {
      this.close(CloseCode.BadHello, 'no hello within the greeting deadline')
      return
    }

    // Idle means nothing at all has happened here: no content in either
    // direction, and no sign of life from the peer. Counting content alone
    // would hang up on a pair that was keeping itself alive in exactly the way
    // this relay documents, and telling somebody to send keepalives that do not
    // work is worse than having no keepalive to offer.
    const quietSince = Math.max(this.lastSpliceAt, this.lastHeardAt)
    if (this.state === 'paired' && config.idleTimeoutMs > 0 && now - quietSince >= config.idleTimeoutMs) {
      this.endForSilence()
      return
    }

    // Liveness is only core's business where the host gave it a ping to send.
    const ping = this.socket.ping
    if (ping === null) return

    // Anything heard within the last keepalive interval is proof enough of life,
    // so sweeping again at the same instant is a no-op. That is what lets the
    // deadlines be driven one step at a time instead of waited out.
    if (now - this.lastHeardAt < config.keepaliveIntervalMs) return

    if (this.awaitingPong) {
      if (now - this.lastPingAt < config.keepaliveIntervalMs) return
      // A NAT that forgot the mapping leaves a socket that looks open and will
      // never speak again. There is nothing polite to send it, so it is cut.
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

  /**
   * Both halves hear the same true thing. Closing this one on its own would
   * leave `leave` to tell the other that its partner disconnected, and nothing
   * disconnected: they were both quiet, and both are being reaped for it.
   */
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

    // State and session id were set by `markPaired` from inside `join`, for both
    // halves at once; there is nothing left here but to say it happened.
    this.host.log.info('session.opened', { conn: this.id, pair: outcome.pairRef, session: outcome.sessionId })
  }

  private releaseRendezvous(): void {
    if (this.token === null) return
    this.host.rendezvous.leave(this.token, this)
  }
}
