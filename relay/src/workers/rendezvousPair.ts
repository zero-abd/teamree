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
import { CloseCode, parseHello, PING_FRAME, PONG_FRAME } from '../core/protocol.js'
import { randomHex } from '../core/random.js'
import { Rendezvous } from '../core/rendezvous.js'
import { createWorkersLogger } from './logging.js'
import { rendezvousId } from './rendezvousId.js'

const OPEN = 1

/**
 * How many sockets one object will hold, counted separately by what each one has
 * proved, because the two kinds are not interchangeable.
 *
 * An object holds one pairing, and `Rendezvous` already refuses to run more than
 * one: a third peer that presents the token displaces the two that were there.
 * So three sockets may hold the pairing — the pair, plus the one arriving to
 * take it over — and a socket holds one of those slots only once it has said a
 * hello that names this object.
 *
 * A socket that has not said its hello yet has proved nothing at all. Counting
 * those against the same three was a way to shut a named rendezvous: the object
 * is addressed by a hash out of the URL, so three connections presenting no
 * hello, no token and no proof of anything could take every slot and leave the
 * teammate who owns the pairing refused at the door. They get their own budget
 * instead, and when it is full the *oldest* of them is displaced rather than the
 * newcomer refused — a socket that has been sitting silent is the one with
 * nothing to lose, and the arriving peer gets its chance to speak.
 *
 * Both caps exist because each frame this object handles costs work linear in
 * how many sockets are attached. Six is that bound.
 */
const MAX_PAIRING_SOCKETS = 3
const MAX_GREETING_SOCKETS = 3

/** The slice of the Durable Object runtime this needs, named so it can be faked. */
export type PairState = {
  /**
   * The object's own id. Its `name` is the rendezvous hash the Worker routed on,
   * and it is what a hello is checked against. Optional because it is the
   * runtime's to provide: a host that does not name its objects after the
   * rendezvous has nothing to check, and a fake need not pretend to.
   */
  id?: { name?: string }
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

/** A socket that is attached but has not said a hello this object accepted. */
type Greeting = { socket: PairSocket; snapshot: SessionSnapshot }

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
    const held = this.census()
    if (held.pairing >= MAX_PAIRING_SOCKETS) {
      this.log.warn('upgrade.refused', {
        reason: 'rendezvous already holds as many connections as a pairing can account for',
        addressRef: this.log.ref(origin)
      })
      return false
    }
    // Room is made rather than refused: whoever is arriving may be the teammate
    // this rendezvous belongs to, and the sockets in the way have said nothing.
    if (held.greeting.length >= MAX_GREETING_SOCKETS) this.displaceOldestGreeting(held.greeting)
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
    if (typeof message === 'string') {
      // A hello is what buys a socket one of this object's pairing slots, and
      // this is where it is made to cost something: the token has to be the one
      // this object is named after. Without the check, a hello carrying a token
      // nobody has ever seen parks a socket here for the whole pairing budget —
      // ten minutes by default, rather than the ten seconds a silent one gets —
      // and three of those keep the pair that owns the rendezvous out of it.
      if (session.currentState === 'greeting' && !(await this.namesThisObject(message))) {
        session.close(CloseCode.BadHello, 'this hello is for a different rendezvous')
        this.persist(live.sessions)
        return
      }
      session.onText(message)
    } else session.onBinary(new Uint8Array(message))
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
    // Only while there is still something to sweep. An alarm that re-armed
    // unconditionally would wake this object every interval for as long as the
    // account exists, once for every rendezvous anybody ever used, long after
    // the two peers went home — and the bill for that goes to a team, not to
    // us. A peer that comes back arms it again on the way in.
    if (this.occupied() > 0) await this.armAlarm()
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
   * Sockets that still have a session on them, split by whether they have said a
   * hello this object accepted. The two caps are spent against the two halves.
   *
   * A peer that was just displaced stays attached for the moment between being
   * told and its close arriving, and it must not hold a slot against the
   * connection that displaced it. A socket whose attachment cannot be read is
   * counted against the pairing slots and never displaced: the object cannot
   * tell whether it is finished, and guessing in the other direction is what
   * would let the cap be walked past and what would leave a live connection with
   * nothing checking its deadlines.
   */
  private census(): { pairing: number; greeting: Greeting[] } {
    let pairing = 0
    const greeting: Greeting[] = []
    for (const socket of this.state.getWebSockets()) {
      const snapshot = readSnapshot(socket)
      if (snapshot === null) {
        pairing += 1
        continue
      }
      if (snapshot.state === 'closed') continue
      if (snapshot.state === 'greeting') greeting.push({ socket, snapshot })
      else pairing += 1
    }
    return { pairing, greeting }
  }

  /** Everything still here, which is what the alarm asks before re-arming. */
  private occupied(): number {
    const held = this.census()
    return held.pairing + held.greeting.length
  }

  /**
   * Makes room for an arriving connection by ending the silent one that has been
   * here longest. Told with the capacity code rather than a protocol complaint:
   * a connection displaced in the moment before its own hello landed did nothing
   * wrong, and backing off and returning is the right answer for it.
   */
  private displaceOldestGreeting(greeting: readonly Greeting[]): void {
    let oldest = greeting[0]
    if (oldest === undefined) return
    for (const candidate of greeting) {
      if (candidate.snapshot.openedAt < oldest.snapshot.openedAt) oldest = candidate
    }
    const session = this.build(oldest.socket, oldest.snapshot.id, oldest.snapshot.origin, oldest.snapshot)
    session.close(CloseCode.Capacity, 'displaced by an arriving connection before saying anything')
    this.log.info('greeting.displaced', { conn: oldest.snapshot.id })
    try {
      oldest.socket.serializeAttachment(session.snapshot())
    } catch {
      // Gone already, which is the outcome that was wanted.
    }
  }

  /**
   * Whether a hello is for the rendezvous this object is named after. The name
   * is `SHA-256(token)` and the hello carries the token, so the object can check
   * the two agree without the token ever having been in the URL.
   */
  private async namesThisObject(text: string): Promise<boolean> {
    const expected = this.state.id?.name
    if (expected === undefined) return true
    const parsed = parseHello(text)
    // Malformed, wrong version, not a token: core has better words for all of
    // those and closes with them a line later.
    if (!parsed.ok) return true
    return (await rendezvousId(parsed.hello.rendezvous)) === expected
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
