// The Durable Object adapter, exercised the way the runtime actually treats it:
// thrown away between frames.
//
// A pair of teammates sits idle for hours at a time, so the object holding them
// is evicted from memory and rebuilt on the next frame. That is the cheap path
// and the normal one, which makes it the path most worth testing — a splice that
// only works while the object happens to still be resident would look perfect in
// development and drop frames in the evening.
//
// The runtime itself is faked, deliberately and narrowly: everything under test
// is the relay's own code, and the fake does only what the Durable Objects
// documentation says the real one does — deliver messages to a handler, keep
// each socket's attachment across eviction, and run an alarm.

import { describe, expect, it } from 'vitest'
import { CloseCode, PING_FRAME, PONG_FRAME } from '../src/core/protocol.js'
import { RendezvousPair, type PairSocket, type PairState } from '../src/workers/rendezvousPair.js'
import { captureLog, createManualClock, rendezvousToken, type ManualClock } from './support/harness.js'

const OPEN = 1
const CLOSED = 3

type Sent = { text?: string; binary?: Uint8Array }

class FakeSocket implements PairSocket {
  readyState = OPEN
  readonly sent: Sent[] = []
  closedWith: { code: number | undefined; reason: string | undefined } | undefined
  /** The runtime keeps this across hibernation; a closed socket loses it. */
  private attachment: unknown = null
  private readable = true

  /** Stands in for a socket the runtime is part-way through taking away. */
  breakAttachment(): void {
    this.readable = false
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') this.sent.push({ text: data })
    else if (data instanceof ArrayBuffer) this.sent.push({ binary: new Uint8Array(data) })
    else this.sent.push({ binary: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.closedWith = { code, reason }
  }

  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value)) as unknown
  }

  deserializeAttachment(): unknown {
    if (!this.readable) throw new Error('this websocket is not in a state to be read')
    return this.attachment
  }

  get control(): string[] {
    return this.sent.flatMap((frame) => (frame.text === undefined ? [] : [frame.text]))
  }

  get binary(): Uint8Array[] {
    return this.sent.flatMap((frame) => (frame.binary === undefined ? [] : [frame.binary]))
  }
}

class FakeState implements PairState {
  readonly sockets: FakeSocket[] = []
  private alarmAt: number | null = null
  private readonly autoResponses = new Map<FakeSocket, number>()

  acceptWebSocket(socket: PairSocket): void {
    this.sockets.push(socket as FakeSocket)
  }

  getWebSockets(): PairSocket[] {
    return this.sockets.filter((socket) => socket.readyState === OPEN)
  }

  setWebSocketAutoResponse(): void {}

  /**
   * The runtime answering a peer's keepalive on the object's behalf, which is
   * the whole point of the auto-response: the object is not woken, so the
   * timestamp below is the only trace that the peer is still there.
   */
  autoRespond(socket: FakeSocket, at: number): void {
    socket.send(PONG_FRAME)
    this.autoResponses.set(socket, at)
  }

  getWebSocketAutoResponseTimestamp(socket: PairSocket): Date | null {
    const at = this.autoResponses.get(socket as FakeSocket)
    return at === undefined ? null : new Date(at)
  }

  readonly storage = {
    getAlarm: async (): Promise<number | null> => this.alarmAt,
    setAlarm: async (at: number): Promise<void> => {
      this.alarmAt = at
    }
  }

  get pendingAlarm(): number | null {
    return this.alarmAt
  }

  clearAlarm(): void {
    this.alarmAt = null
  }
}

/**
 * A relay whose Durable Object is rebuilt for every single event, which is the
 * worst case the runtime is allowed to put it in.
 */
function hibernatingPair(overrides: Record<string, string> = {}) {
  const state = new FakeState()
  const clock: ManualClock = createManualClock()
  const log = captureLog(clock.now)
  const environment = { RELAY_KEEPALIVE_INTERVAL_MS: '30000', ...overrides }
  // Rebuilt on purpose: a fresh object every time is what hibernation means.
  const object = (): RendezvousPair => new RendezvousPair(state, environment, { clock, log: log.logger })
  return {
    state,
    clock,
    log,
    connect: (origin = '203.0.113.1'): FakeSocket => {
      const socket = new FakeSocket()
      expect(object().accept(socket, origin)).toBe(true)
      return socket
    },
    /** An upgrade the object is free to refuse, which `connect` is not. */
    offer: (origin = '203.0.113.1'): { socket: FakeSocket; accepted: boolean } => {
      const socket = new FakeSocket()
      return { socket, accepted: object().accept(socket, origin) }
    },
    keepalive: (socket: FakeSocket): void => state.autoRespond(socket, clock.now()),
    say: async (socket: FakeSocket, message: string | Uint8Array): Promise<void> => {
      const frame = typeof message === 'string' ? message : toArrayBuffer(message)
      await object().onMessage(socket, frame)
    },
    vanish: async (socket: FakeSocket): Promise<void> => {
      socket.readyState = CLOSED
      await object().onClose(socket, 1006)
    },
    tick: async (): Promise<void> => {
      state.clearAlarm()
      await object().onAlarm()
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function hello(token: string): string {
  return JSON.stringify({ version: 1, rendezvous: token })
}

describe('a pairing held by a durable object', () => {
  it('splices two peers that were evicted from memory between every frame', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()

    await relay.say(first, hello(token))
    await relay.say(second, hello(token))
    expect(JSON.parse(first.control[1] ?? '{}')).toMatchObject({ t: 'paired', initiator: false })
    expect(JSON.parse(second.control[0] ?? '{}')).toMatchObject({ t: 'paired', initiator: true })

    const payload = new Uint8Array([0, 1, 2, 250, 251, 255])
    await relay.say(first, payload)

    expect(second.binary).toHaveLength(1)
    expect([...(second.binary[0] ?? [])]).toEqual([...payload])
  })

  it('keeps splicing across an eviction in the middle of a conversation', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    // Hours of nothing, then both sides pick up where they left off.
    relay.clock.advance(6 * 60 * 60 * 1000)
    await relay.say(first, new Uint8Array([7]))
    await relay.say(second, new Uint8Array([8]))

    expect([...(second.binary[0] ?? [])]).toEqual([7])
    expect([...(first.binary[0] ?? [])]).toEqual([8])
  })

  it('tells the survivor when its partner vanishes, having forgotten it ever paired them', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    await relay.vanish(second)

    expect(first.closedWith?.code).toBe(CloseCode.PartnerGone)
  })

  it('lets a returning peer displace a pairing it cannot remember making', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const stale = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(stale, hello(token))

    const returning = relay.connect()
    await relay.say(returning, hello(token))

    expect(first.closedWith?.code).toBe(CloseCode.Superseded)
    expect(stale.closedWith?.code).toBe(CloseCode.Superseded)
    expect(JSON.parse(returning.control[0] ?? '{}')).toEqual({ t: 'waiting' })
  })

  it('answers a peer keepalive without needing to know anything about it', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const peer = relay.connect()
    await relay.say(peer, hello(token))

    await relay.say(peer, PING_FRAME)

    expect(peer.control.at(-1)).toBe(PONG_FRAME)
  })

  it('enforces the same budgets a long-lived pair would exhaust', async () => {
    const relay = hibernatingPair({ RELAY_MAX_FRAMES_PER_SECOND: '4' })
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    // The budget has to survive eviction too, or a peer could refill it simply
    // by being quiet long enough for the object to be swapped out.
    for (let index = 0; index < 5; index += 1) await relay.say(first, new Uint8Array([index]))

    expect(first.closedWith?.code).toBe(CloseCode.RateLimited)
    expect(second.binary).toHaveLength(4)
  })

  it('sends a peer away on the alarm when nobody joined it', async () => {
    const relay = hibernatingPair({ RELAY_PAIR_TIMEOUT_MS: '60000' })
    const lonely = relay.connect()
    await relay.say(lonely, hello(rendezvousToken()))

    relay.clock.advance(60_000)
    await relay.tick()

    expect(lonely.closedWith?.code).toBe(CloseCode.PairTimeout)
  })

  it('sets an alarm so the deadlines are checked even though nothing is running', async () => {
    const relay = hibernatingPair()
    const peer = relay.connect()
    await relay.say(peer, hello(rendezvousToken()))

    expect(relay.state.pendingAlarm).toBe(relay.clock.now() + 30_000)
  })

  it('takes no more sockets than a pairing can account for, however many are offered', () => {
    const relay = hibernatingPair()

    // The object's name is a hex string the client picked, with no token behind
    // it: anybody may address any object, so the object is what has to say no.
    const offered = Array.from({ length: 200 }, () => relay.offer())

    expect(offered.filter((attempt) => attempt.accepted)).toHaveLength(3)
    expect(relay.log.records.filter((record) => record.event === 'upgrade.refused')).toHaveLength(197)
  })

  it('still has room for the peer that arrives to displace the pair', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const stale = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(stale, hello(token))

    // Two is what an object holds and three is what it must admit, or a peer
    // whose laptop slept could never take its own session back.
    const returning = relay.offer()
    expect(returning.accepted).toBe(true)
    await relay.say(returning.socket, hello(token))

    const partner = relay.offer()
    expect(partner.accepted).toBe(true)
    await relay.say(partner.socket, hello(token))
    expect(JSON.parse(returning.socket.control.at(-1) ?? '{}')).toMatchObject({ t: 'paired' })
  })

  it('counts the keepalive the runtime answered without waking it', async () => {
    const relay = hibernatingPair({ RELAY_IDLE_TIMEOUT_MS: '600000' })
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    // Twenty-two rounds of the keepalive this relay documents, which is the
    // only one a peer has on this host. None of them wakes the object, so if
    // the alarm went by what it had been handed it would reap a live pair.
    for (let round = 0; round < 22; round += 1) {
      relay.keepalive(first)
      relay.keepalive(second)
      relay.clock.advance(30_000)
      await relay.tick()
    }

    expect(first.closedWith).toBeUndefined()
    expect(second.closedWith).toBeUndefined()
  })

  it('tells both halves the truth when it reaps a pair for silence', async () => {
    const relay = hibernatingPair({ RELAY_IDLE_TIMEOUT_MS: '600000' })
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    relay.clock.advance(600_000)
    await relay.tick()

    // Neither of them disconnected, so neither may be told the other did.
    expect(first.closedWith?.code).toBe(CloseCode.Idle)
    expect(second.closedWith?.code).toBe(CloseCode.Idle)
  })

  it('says so rather than dropping a frame it has no state for', async () => {
    const relay = hibernatingPair()
    const stranger = new FakeSocket()

    await relay.say(stranger, new Uint8Array([1]))

    // Sessions are found by the identity of the socket the runtime hands back.
    // Nothing here can check that a hibernation wake preserves it, so the one
    // thing that must not happen is losing a frame in silence.
    expect(relay.log.records.some((record) => record.event === 'connection.unknown')).toBe(true)
    expect(stranger.closedWith?.code).toBe(CloseCode.GoingAway)
  })

  it('still tells a survivor its partner left when another socket cannot be read', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    // A socket the runtime is part-way through taking away. Whatever the real
    // platform does with a read like this, one of them failing must not cost
    // the pair beside it the message that matters most.
    const breaking = relay.connect()
    breaking.breakAttachment()
    await relay.vanish(second)

    expect(first.closedWith?.code).toBe(CloseCode.PartnerGone)
  })

  it('gives whoever deployed it no way to read what the pair is saying', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    const secret = 'not-for-the-person-with-the-cloudflare-account'
    await relay.say(first, new TextEncoder().encode(secret))

    // The operator's whole view of this object is its log. In production the
    // payload would be ciphertext as well; here it is plaintext so that any leak
    // would be visible.
    const logs = relay.log.lines.join('\n')
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain(token)
  })
})
