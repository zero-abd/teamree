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

  acceptWebSocket(socket: PairSocket): void {
    this.sockets.push(socket as FakeSocket)
  }

  getWebSockets(): PairSocket[] {
    return this.sockets.filter((socket) => socket.readyState === OPEN)
  }

  setWebSocketAutoResponse(): void {}

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
      object().accept(socket, origin)
      return socket
    },
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
