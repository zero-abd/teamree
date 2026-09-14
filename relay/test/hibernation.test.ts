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
import { rendezvousId } from '../src/workers/rendezvousId.js'
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
  /**
   * What the runtime calls this object. The Worker addresses one by the hash of
   * a rendezvous, so this is the only thing an object can check a hello against.
   * Left nameless unless a test is about that.
   */
  readonly id: { name?: string }
  private alarmAt: number | null = null
  private readonly autoResponses = new Map<FakeSocket, number>()

  constructor(name?: string) {
    this.id = name === undefined ? {} : { name }
  }

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
function hibernatingPair(overrides: Record<string, string> = {}, name?: string) {
  const state = new FakeState(name)
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

  it('lets itself be forgotten once the last connection has gone', async () => {
    const relay = hibernatingPair()
    const peer = relay.connect()
    await relay.say(peer, hello(rendezvousToken()))

    await relay.vanish(peer)
    await relay.tick()

    // Re-arming here would wake this object every interval for as long as the
    // account exists, once per rendezvous anybody ever used. There is nothing
    // left to sweep, and a peer that comes back arms it again on the way in.
    expect(relay.state.pendingAlarm).toBeNull()

    const returning = relay.connect()
    await relay.say(returning, hello(rendezvousToken()))
    expect(relay.state.pendingAlarm).toBe(relay.clock.now() + 30_000)
  })

  it('keeps a rendezvous open for its own pair however many sockets are aimed at it', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()

    // The object's name is a hex string the client picked, with no token behind
    // it: anybody may address any object. None of these has said a word, so none
    // of them may cost the pair the rendezvous belongs to its place in it.
    const offered = Array.from({ length: 200 }, () => relay.offer())
    expect(offered.every((attempt) => attempt.accepted)).toBe(true)

    // Bounded all the same, because every frame this object handles costs work
    // in proportion to what is attached: each arrival ends the silent socket
    // that has been here longest rather than being refused itself.
    expect(relay.state.getWebSockets()).toHaveLength(3)
    expect(offered.filter((attempt) => attempt.socket.closedWith?.code === CloseCode.Capacity)).toHaveLength(197)

    const first = relay.connect()
    await relay.say(first, hello(token))
    const second = relay.connect()
    await relay.say(second, hello(token))

    expect(JSON.parse(second.control[0] ?? '{}')).toMatchObject({ t: 'paired' })
  })

  it('never refuses an upgrade to a connection that presents its own rendezvous', async () => {
    const token = rendezvousToken()
    const relay = hibernatingPair({ RELAY_PAIR_TIMEOUT_MS: '600000' }, await rendezvousId(token))

    // Three sockets may hold the pairing, and the third one's whole purpose is
    // that a peer coming back from a suspend takes its own session over. So the
    // pairing half never fills from the pair's own side: every hello that names
    // this object either parks, pairs, or displaces what was here, which leaves
    // at most two live sockets holding it. Six arrivals in a row, and not one of
    // them is handed a refusal — which matters because a refused upgrade reaches
    // a WebSocket client as a transport error it cannot tell from a relay that
    // is not there.
    const arrivals: FakeSocket[] = []
    for (let arrival = 0; arrival < 6; arrival += 1) {
      const offered = relay.offer()
      expect(offered.accepted).toBe(true)
      await relay.say(offered.socket, hello(token))
      arrivals.push(offered.socket)
    }

    expect(relay.log.records.some((record) => record.event === 'upgrade.refused')).toBe(false)
    expect(JSON.parse(arrivals.at(-1)?.control.at(-1) ?? '{}')).toMatchObject({ t: 'paired' })
  })

  it('refuses an upgrade only when it cannot account for what is already attached', () => {
    const relay = hibernatingPair()
    const attached = [relay.connect(), relay.connect(), relay.connect()]

    // A socket whose state the object cannot read is counted against the pairing
    // half and never displaced: the object cannot tell whether that connection
    // is finished, and guessing the other way is how the cap gets walked past
    // and how a live peer ends up with nothing checking its deadlines. Three of
    // those is the whole of what is left of the 503, and it is not a state
    // anybody holding the URL can arrange — it is the runtime taking a socket
    // away while the object is still looking at it.
    for (const socket of attached) socket.breakAttachment()

    expect(relay.offer().accepted).toBe(false)
    expect(relay.log.records.some((record) => record.event === 'upgrade.refused')).toBe(true)
  })

  it('answers a hello for another rendezvous the same way whether or not the pair is here', async () => {
    const token = rendezvousToken()
    const name = await rendezvousId(token)

    const empty = hibernatingPair({}, name)
    const atAnEmptyOne = empty.connect()
    await empty.say(atAnEmptyOne, hello(rendezvousToken()))

    const busy = hibernatingPair({}, name)
    const owner = busy.connect()
    const partner = busy.connect()
    await busy.say(owner, hello(token))
    await busy.say(partner, hello(token))
    const atABusyOne = busy.connect()
    await busy.say(atABusyOne, hello(rendezvousToken()))

    // Whoever has the URL has the hash, and a hash is not a token. What they are
    // told back must not vary with whether the two people it belongs to are in
    // there: an answer that differs when the rendezvous is occupied is a way to
    // watch a pair you cannot join. Both probes get the same words, and the pair
    // never hears that either of them happened.
    expect(atABusyOne.closedWith).toEqual(atAnEmptyOne.closedWith)
    expect(atABusyOne.control).toEqual(atAnEmptyOne.control)
    expect(owner.closedWith).toBeUndefined()
    expect(partner.closedWith).toBeUndefined()
    expect(partner.control.map((frame) => (JSON.parse(frame) as { t: string }).t)).toEqual(['paired'])
  })

  it('has no connection cap to spend, because a Worker has no process to count across', () => {
    // RELAY_MAX_CONNECTIONS is a count across a whole process. It parses here,
    // because the configuration is shared with the container host, and then
    // there is nowhere to apply it. What bounds this host instead is the fixed
    // number of sockets one object will hold. `wrangler.jsonc` leaves the
    // variable out rather than carrying one the relay reads and then ignores,
    // and `test/hosts.test.ts` holds the file to that.
    const relay = hibernatingPair({ RELAY_MAX_CONNECTIONS: '2' })

    expect([relay.offer(), relay.offer(), relay.offer()].map((offered) => offered.accepted)).toEqual([true, true, true])
  })

  it('has no send queue to measure, so nobody here is closed for not reading', async () => {
    const relay = hibernatingPair({
      RELAY_MAX_BUFFERED_BYTES: '65536',
      RELAY_MAX_FRAME_BYTES: '65536',
      RELAY_MAX_FRAMES_PER_SECOND: '1000'
    })
    const peer = relay.connect()
    await relay.say(peer, hello(rendezvousToken()))

    // The container host closes exactly this peer — one that asks for pongs and
    // never takes them off its socket — in `test/limits.test.ts`, "closes a peer
    // that is not reading the answers it asked for". Here the runtime owns the
    // send queue and does not expose its depth, so the relay has nothing to
    // compare against the bound and the rule never fires however low the bound
    // is set. That is a limitation rather than a decision, README.md says so in
    // those words, and this is what stops it being quietly untrue in either
    // direction: if the runtime ever did expose a depth, this would go red and
    // the paragraph would need rewriting.
    for (let asked = 0; asked < 300; asked += 1) await relay.say(peer, PING_FRAME)

    expect(peer.closedWith).toBeUndefined()
    expect(peer.control.filter((frame) => frame === PONG_FRAME)).toHaveLength(300)
  })

  it('refuses a frame over the size cap rather than passing it on', async () => {
    const relay = hibernatingPair({ RELAY_MAX_FRAME_BYTES: '4096' })
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    await relay.say(first, new Uint8Array(4097))

    // 1009 is the standard "message too big", so any client understands it
    // without knowing this relay. The cap is a rule of the relay rather than of
    // whatever parsed the frame, which is why it is checked on this host too:
    // there is no `ws` underneath here to have refused it first.
    expect(first.closedWith?.code).toBe(CloseCode.TooLarge)
    expect(second.binary).toHaveLength(0)
  })

  it('closes a peer sending bytes faster than its budget allows', async () => {
    const relay = hibernatingPair({ RELAY_MAX_FRAME_BYTES: '4096', RELAY_MAX_BYTES_PER_SECOND: '8192' })
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))

    // The clock does not move, so the bucket never refills: two full frames are
    // the whole of one second's budget and the third is over it by arithmetic.
    // With no connection cap and no queue to measure, the two rate budgets are
    // the whole of what bounds one peer's demand on this object.
    for (let frame = 0; frame < 3; frame += 1) await relay.say(first, new Uint8Array(4096))

    expect(first.closedWith?.code).toBe(CloseCode.RateLimited)
    expect(second.binary).toHaveLength(2)
  })

  it('turns away a hello for a rendezvous it is not the home of', async () => {
    const token = rendezvousToken()
    const relay = hibernatingPair({ RELAY_PAIR_TIMEOUT_MS: '600000' }, await rendezvousId(token))

    // A token nobody but the sender has ever seen, presented to an object named
    // after one two teammates share. Unchecked, this parks a socket here for the
    // whole pairing budget — ten minutes — instead of the ten seconds a silent
    // one gets, and three of them shut the rendezvous.
    const squatter = relay.connect()
    await relay.say(squatter, hello(rendezvousToken()))
    expect(squatter.closedWith?.code).toBe(CloseCode.BadHello)

    // And the hello that does name this object is untouched.
    const owner = relay.connect()
    await relay.say(owner, hello(token))
    expect(JSON.parse(owner.control[0] ?? '{}')).toEqual({ t: 'waiting' })
  })

  it('charges a peer for its control frames as well as for its content', async () => {
    const relay = hibernatingPair({ RELAY_MAX_FRAMES_PER_SECOND: '4' })
    const peer = relay.connect()
    await relay.say(peer, hello(rendezvousToken()))

    // This host has no send queue to measure and no connection cap, so the
    // budgets are the whole of what bounds one peer's demand on the object.
    for (let index = 0; index < 5; index += 1) await relay.say(peer, PING_FRAME)

    expect(peer.closedWith?.code).toBe(CloseCode.RateLimited)
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

  it('sends a survivor back rather than blaming it for state the object lost', async () => {
    const relay = hibernatingPair()
    const token = rendezvousToken()
    const first = relay.connect()
    const second = relay.connect()
    await relay.say(first, hello(token))
    await relay.say(second, hello(token))
    await relay.say(first, new Uint8Array([1]))

    // One event in which the runtime is part-way through taking the partner's
    // socket away. The pairing is rebuilt without it, so this peer's own state
    // says paired and the table it is looked up in does not.
    second.breakAttachment()
    await relay.say(first, new Uint8Array([2]))

    // 1001, which a client comes back from. A protocol complaint would be this
    // object telling a peer that did nothing wrong that its client is broken,
    // for a socket the peer cannot see and a table it did not write.
    expect(first.closedWith?.code).toBe(CloseCode.GoingAway)
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
