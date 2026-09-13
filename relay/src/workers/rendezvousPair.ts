// The Durable Object that holds one pairing.
//
// One object per rendezvous is the whole point: the pairing has a single
// consistent home, addressed by a name derived from the rendezvous, and the two
// peers land in it from wherever they are. Nothing about the relay's rules lives
// here — they are all in core, which this file wakes up, hands an event to, and
// writes back down.
//
// It uses the WebSocket Hibernation API, because a pair that sits quiet for
// hours is the normal case rather than the exception. Hibernation means the
// object is evicted from memory between frames and its constructor runs again on
// the next one, so nothing may be kept in a field: every event begins by
// rebuilding the sessions from what is attached to each socket, and ends by
// writing them back. `SessionSnapshot` is what makes that possible, and the test
// for it throws this object away between frames on purpose.

import type { Clock } from '../core/clock.js'
import { configFromEnv, type RelayConfig } from '../core/config.js'
import type { Logger } from '../core/log.js'
import { PeerSession, type PeerSocket, type SessionHost, type SessionSnapshot } from '../core/peerSession.js'
import { CloseCode, PING_FRAME, PONG_FRAME } from '../core/protocol.js'
import { randomHex } from '../core/random.js'
import { Rendezvous } from '../core/rendezvous.js'
import { createWorkersLogger } from './logging.js'

const OPEN = 1

/**
 * How many sockets one object will hold.
 *
 * An object holds one pairing, and `Rendezvous` already refuses to run more than
 * one: a third peer that presents the token displaces the two that were there.
 * The socket count has to let that third one in — displacing is how a peer whose
 * laptop slept gets its session back — and nothing beyond it. So three, not two:
 * the pair, plus the one arriving to take it over.
 *
 * A cap is needed at all because the object's name is a client-chosen hex string
 * with no token behind it and no proof of anything. Without one, a client is
 * free to point every socket it can open at a single object, and each frame that
 * object then handles costs work linear in how many are attached.
 */
const MAX_SOCKETS = 3

/** The slice of the Durable Object runtime this needs, named so it can be faked. */
export type PairState = {
  acceptWebSocket: (socket: PairSocket, tags?: string[]) => void
  getWebSockets: (tag?: string) => PairSocket[]
  setWebSocketAutoResponse: (pair: unknown) => void
  /**
   * When the runtime last answered this socket's keepalive on the object's
   * behalf. Optional because it is the runtime's to provide and a fake need not.
   */
  getWebSocketAutoResponseTimestamp?: (socket: PairSocket) => Date | null
  storage: { getAlarm: () => Promise<number | null>; setAlarm: (at: number) => Promise<void> }
}

export type PairSocket = {
  readyState: number
  send: (data: string | ArrayBuffer | ArrayBufferView) => void
  close: (code?: number, reason?: string) => void
  serializeAttachment: (value: unknown) => void
  deserializeAttachment: () => unknown
}

export type PairEnvironment = Record<string, string | undefined>

/**
 * The runtime owns this socket and may be part-way through taking it away. A
 * read that throws is not a reason to fail the event being handled — and on a
 * close, failing it is exactly how a partner ends up never being told.
 */
function readSnapshot(socket: PairSocket): SessionSnapshot | null {
  try {
    return (socket.deserializeAttachment() as SessionSnapshot | null) ?? null
  } catch {
    return null
  }
}

export type PairDependencies = {
  clock?: Clock
  log?: Logger
  /** Builds the runtime's ping/pong auto-response object. Absent in tests. */
  autoResponse?: (request: string, response: string) => unknown
}

export class RendezvousPair {
  private readonly state: PairState
  private readonly config: RelayConfig
  private readonly clock: Clock
  private readonly log: Logger
  private readonly autoResponse: ((request: string, response: string) => unknown) | undefined

  constructor(state: PairState, env: PairEnvironment, dependencies: PairDependencies = {}) {
    this.state = state
    this.config = configFromEnv(env)
    this.clock = dependencies.clock ?? { now: () => Date.now() }
    this.log = dependencies.log ?? createWorkersLogger()
    this.autoResponse = dependencies.autoResponse

    // Answered by the runtime without waking this object at all, which is what
    // makes a peer's keepalive free rather than the thing that stops hibernation
    // from ever paying off.
    if (this.autoResponse !== undefined) {
      this.state.setWebSocketAutoResponse(this.autoResponse(PING_FRAME, PONG_FRAME))
    }
  }

  /**
   * Takes over an upgrade the Worker has routed here, or refuses it. False means
   * the object already holds as many connections as a pairing can account for,
   * and the caller must answer the upgrade rather than complete it.
   */
  accept(socket: PairSocket, origin: string): boolean {
    if (this.occupied() >= MAX_SOCKETS) {
      this.log.warn('upgrade.refused', {
        reason: 'rendezvous already holds as many connections as a pairing can account for',
        addressRef: this.log.ref(origin)
      })
      return false
    }
    this.state.acceptWebSocket(socket)
    const id = `peer_${randomHex(6)}`
    const session = this.build(socket, id, origin, undefined)
    socket.serializeAttachment(session.snapshot())
    this.log.info('connection.opened', { conn: id, addressRef: this.log.ref(origin) })
    void this.armAlarm()
    return true
  }

  async onMessage(socket: PairSocket, message: string | ArrayBuffer): Promise<void> {
    const live = this.rehydrate()
    const session = live.sessions.get(socket)
    if (session === undefined) {
      this.unknownSocket(socket, 'message')
      return
    }
    if (typeof message === 'string') session.onText(message)
    else session.onBinary(new Uint8Array(message))
    this.persist(live.sessions)
    await this.armAlarm()
  }

  async onClose(socket: PairSocket, code: number): Promise<void> {
    // The closing socket is passed in explicitly because the runtime may already
    // have dropped it from the attached set by the time this runs, and a partner
    // that is never told its peer left is the worst failure this relay has.
    const live = this.rehydrate(socket)
    const session = live.sessions.get(socket)
    if (session === undefined) {
      this.unknownSocket(socket, 'close')
      return
    }
    session.onSocketClosed(code)
    this.persist(live.sessions)
  }

  async onError(socket: PairSocket, error: unknown): Promise<void> {
    this.log.warn('connection.error', { reason: error instanceof Error ? error.message : String(error) })
    await this.onClose(socket, 1006)
  }

  /** The alarm is this host's sweep: the same deadlines, on a different timer. */
  async onAlarm(): Promise<void> {
    const live = this.rehydrate()
    const now = this.clock.now()
    for (const peer of live.rendezvous.expiredWaiters(now, this.config.pairTimeoutMs)) {
      peer.close(CloseCode.PairTimeout, 'no partner arrived within the pairing budget')
    }
    for (const session of live.sessions.values()) session.sweep(now)
    this.persist(live.sessions)
    await this.armAlarm()
  }

  /**
   * Rebuilds every session from what is attached to its socket, and the pairing
   * table from the sessions. This is the whole of what hibernation costs.
   */
  private rehydrate(alsoInclude?: PairSocket): { sessions: Map<PairSocket, PeerSession>; rendezvous: Rendezvous } {
    const rendezvous = new Rendezvous()
    const sessions = new Map<PairSocket, PeerSession>()
    const byToken = new Map<string, PeerSession[]>()

    const attached = this.state.getWebSockets()
    const all = alsoInclude !== undefined && !attached.includes(alsoInclude) ? [...attached, alsoInclude] : attached

    for (const socket of all) {
      const snapshot = readSnapshot(socket)
      if (snapshot === null) continue
      const session = this.build(socket, snapshot.id, snapshot.origin, snapshot, rendezvous)
      // The runtime answers this peer's keepalive without waking the object, so
      // the timestamp it kept is the only evidence the peer is still there. Read
      // every time rather than on the alarm alone: the session is rebuilt from
      // its attachment, and an attachment cannot record what never woke it.
      const heardAt = this.lastAutoResponse(socket)
      if (heardAt !== null) session.noteHeard(heardAt)
      sessions.set(socket, session)
      if (snapshot.token === null || snapshot.state === 'closed') continue
      const group = byToken.get(snapshot.token) ?? []
      group.push(session)
      byToken.set(snapshot.token, group)
    }

    for (const [token, peers] of byToken) {
      // A displaced peer can still be attached for the moment between being told
      // and its close arriving. Paired sessions are the ones that were real, so
      // they come first and at most two are put back.
      const ordered = [...peers].sort(
        (left, right) => Number(right.snapshot().state === 'paired') - Number(left.snapshot().state === 'paired')
      )
      const keep = ordered.slice(0, 2)
      const lead = keep[0]?.snapshot()
      if (lead === undefined) continue
      rendezvous.restore(token, keep, lead.pairRef ?? '', lead.sessionId, lead.openedAt)
    }

    return { sessions, rendezvous }
  }

  /**
   * Sockets that still have a session on them. A peer that was just displaced
   * stays attached for the moment between being told and its close arriving, and
   * it must not hold a slot against the connection that displaced it. A socket
   * whose attachment cannot be read is counted: the object cannot tell whether
   * it is finished, and guessing in the other direction is what would let the
   * cap be walked past.
   */
  private occupied(): number {
    let held = 0
    for (const socket of this.state.getWebSockets()) {
      if (readSnapshot(socket)?.state !== 'closed') held += 1
    }
    return held
  }

  /**
   * Every session is found by the identity of the socket the runtime hands back,
   * and nothing here checks that a hibernation wake preserves it. If it ever
   * does not, this is the symptom — and a frame dropped in silence is the worst
   * possible way to find that out, so it is said out loud. The connection cannot
   * be served without its state either way, so it is ended rather than left open
   * swallowing frames.
   */
  private unknownSocket(socket: PairSocket, phase: 'message' | 'close'): void {
    this.log.warn('connection.unknown', { phase })
    if (phase === 'close') return
    try {
      // "Going away" rather than a protocol complaint: the peer did nothing
      // wrong, the relay lost its state, and reconnecting is the right answer.
      socket.close(CloseCode.GoingAway, 'no session for this connection')
    } catch {
      // Already gone, which is the same outcome by a different route.
    }
  }

  private lastAutoResponse(socket: PairSocket): number | null {
    const read = this.state.getWebSocketAutoResponseTimestamp
    if (read === undefined) return null
    try {
      return read.call(this.state, socket)?.getTime() ?? null
    } catch {
      return null
    }
  }

  private persist(sessions: Map<PairSocket, PeerSession>): void {
    for (const [socket, session] of sessions) {
      // A socket the runtime has already taken away is not an error worth
      // failing an event over; its state is gone either way.
      try {
        socket.serializeAttachment(session.snapshot())
      } catch {
        continue
      }
    }
  }

  private async armAlarm(): Promise<void> {
    if (this.config.keepaliveIntervalMs <= 0) return
    const existing = await this.state.storage.getAlarm()
    if (existing !== null) return
    await this.state.storage.setAlarm(this.clock.now() + this.config.keepaliveIntervalMs)
  }

  private build(
    socket: PairSocket,
    id: string,
    origin: string,
    snapshot: SessionSnapshot | undefined,
    rendezvous: Rendezvous = new Rendezvous()
  ): PeerSession {
    const port: PeerSocket = {
      isOpen: () => socket.readyState === OPEN,
      sendText: (text) => socket.send(text),
      sendBinary: (payload) => socket.send(payload),
      // The runtime owns the send queue here and does not expose its depth, so
      // core's slow-consumer rule has nothing to measure and never fires. The
      // frame and byte budgets still do, and they are what bound the work.
      backlog: () => 0,
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.close(CloseCode.Protocol, 'terminated'),
      // No WebSocket-protocol ping is exposed to a Durable Object. Liveness is
      // the runtime's, and peers keep themselves alive with the control ping.
      ping: null
    }
    const host: SessionHost = {
      config: this.config,
      clock: this.clock,
      log: this.log,
      rendezvous,
      onClosed: () => {}
    }
    return new PeerSession(id, origin, port, host, snapshot)
  }
}
