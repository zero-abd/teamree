// The Durable Object that holds one pairing; the rules live in core.
// WebSocket Hibernation evicts the object between frames, so nothing may live
// in a field: every event rebuilds sessions from socket attachments and writes them back.

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

// Two budgets, not one: the pair plus the peer arriving to take it over hold the
// pairing slots, and only a hello naming this object buys one. Sockets that have
// said nothing get their own budget, oldest displaced when full, so three silent
// connections to a hashed URL cannot lock the owner out. Each frame costs work
// linear in attached sockets; six is that bound.
const MAX_PAIRING_SOCKETS = 3
const MAX_GREETING_SOCKETS = 3

/** The slice of the Durable Object runtime this needs, named so it can be faked. */
export type PairState = {
  /** `name` is the rendezvous hash the Worker routed on, checked against each hello; a fake need not provide it. */
  id?: { name?: string }
  acceptWebSocket: (socket: PairSocket, tags?: string[]) => void
  getWebSockets: (tag?: string) => PairSocket[]
  setWebSocketAutoResponse: (pair: unknown) => void
  /** When the runtime last answered this socket's keepalive on the object's behalf. */
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

// The runtime may be part-way through taking the socket away; a read that throws
// must not fail the event, or on a close the partner is never told.
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

    // Answered by the runtime without waking this object, so keepalives do not defeat hibernation.
    if (this.autoResponse !== undefined) {
      this.state.setWebSocketAutoResponse(this.autoResponse(PING_FRAME, PONG_FRAME))
    }
  }

  /** Takes over a routed upgrade; false means full, and the caller must answer the upgrade itself. */
  accept(socket: PairSocket, origin: string): boolean {
    const held = this.census()
    if (held.pairing >= MAX_PAIRING_SOCKETS) {
      this.log.warn('upgrade.refused', {
        reason: 'rendezvous already holds as many connections as a pairing can account for',
        addressRef: this.log.ref(origin)
      })
      return false
    }
    // Room is made rather than refused: the arrival may be the owner, and the sockets in the way have said nothing.
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
      // A hello buys a pairing slot only if its token names this object; otherwise
      // an unknown token parks a socket for the whole pairing budget (ten minutes,
      // not the ten seconds a silent one gets) and three of those lock the owner out.
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
    // Passed in explicitly: the runtime may already have dropped the closing socket
    // from the attached set, and a partner never told its peer left is the worst failure here.
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
    // Only while there is something to sweep: an unconditional re-arm would wake
    // every rendezvous ever used, forever, on the team's bill. A returning peer re-arms it.
    if (this.occupied() > 0) await this.armAlarm()
  }

  // Rebuilds every session from its socket attachment, and the pairing table from the sessions.
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
      // The runtime's auto-response timestamp is the only evidence the peer is
      // still there; an attachment cannot record what never woke the object.
      const heardAt = this.lastAutoResponse(socket)
      if (heardAt !== null) session.noteHeard(heardAt)
      sessions.set(socket, session)
      if (snapshot.token === null || snapshot.state === 'closed') continue
      const group = byToken.get(snapshot.token) ?? []
      group.push(session)
      byToken.set(snapshot.token, group)
    }

    for (const [token, peers] of byToken) {
      // A displaced peer stays attached until its close arrives, so paired
      // sessions come first and at most two are put back.
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

  // Live sockets split by whether they have said an accepted hello. A displaced
  // peer must not hold a slot against its displacer; an unreadable attachment
  // counts as pairing and is never displaced, else the cap could be walked past.
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

  private occupied(): number {
    const held = this.census()
    return held.pairing + held.greeting.length
  }

  // Ends the silent connection here longest. Capacity code, not a protocol
  // complaint: it did nothing wrong, and backing off and returning is right for it.
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

  // The object's name is `SHA-256(token)` and the hello carries the token, so the
  // two can be checked against each other without the token ever being in the URL.
  private async namesThisObject(text: string): Promise<boolean> {
    const expected = this.state.id?.name
    if (expected === undefined) return true
    const parsed = parseHello(text)
    // Malformed or wrong version: core has better words for those and closes a line later.
    if (!parsed.ok) return true
    return (await rendezvousId(parsed.hello.rendezvous)) === expected
  }

  // Sessions are found by socket identity, which a hibernation wake is assumed to
  // preserve; if it ever does not, this is the symptom, said out loud rather than
  // dropped in silence.
  private unknownSocket(socket: PairSocket, phase: 'message' | 'close'): void {
    this.log.warn('connection.unknown', { phase })
    if (phase === 'close') return
    try {
      // "Going away", not a protocol complaint: the relay lost the state, and reconnecting is right.
      socket.close(CloseCode.GoingAway, 'no session for this connection')
    } catch {
      // Already gone.
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
      // A socket the runtime already took away is not worth failing an event over.
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
      // The runtime does not expose its send-queue depth, so core's slow-consumer
      // rule never fires here; the frame and byte budgets still bound the work.
      backlog: () => 0,
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.close(CloseCode.Protocol, 'terminated'),
      // No WebSocket-protocol ping is exposed to a Durable Object; peers use the control ping.
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
