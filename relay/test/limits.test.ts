// The limits, which are the difference between a relay a team can leave running
// and one that a single misbehaving client takes down. Every budget here is
// driven by the injected clock, so "over the budget" is an arithmetic fact
// rather than a race against the test runner.

import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/core/config.js'
import { PeerSession, type PeerSocket, type SessionHost } from '../src/core/peerSession.js'
import { CloseCode, PING_FRAME, PONG_FRAME } from '../src/core/protocol.js'
import { Rendezvous } from '../src/core/rendezvous.js'
import {
  captureLog,
  connectPeer,
  createManualClock,
  joinPeer,
  rendezvousToken,
  startTestRelay,
  type TestRelay
} from './support/harness.js'

let harness: TestRelay

afterEach(async () => {
  await harness.relay.close()
})

async function pairedPeers(overrides: Parameters<typeof startTestRelay>[0] = {}) {
  harness = await startTestRelay(overrides)
  const token = rendezvousToken()
  const first = await joinPeer(harness, token)
  const second = await joinPeer(harness, token)
  await first.waitPaired()
  return { first, second }
}

describe('per-connection budgets', () => {
  it('refuses a frame larger than the cap instead of assembling it', async () => {
    const { first } = await pairedPeers({ maxFrameBytes: 4096 })

    first.send(Buffer.alloc(4097))

    // 1009 is the standard "message too big"; the parser rejects it before the
    // payload exists anywhere in the relay.
    expect((await first.waitClosed()).code).toBe(1009)
  })

  it('carries a frame that is exactly the size of the cap', async () => {
    const { first, second } = await pairedPeers({ maxFrameBytes: 4096 })

    first.send(Buffer.alloc(4096, 9))

    expect((await second.binary.atLeast(1))[0]?.length).toBe(4096)
  })

  it('closes a peer sending frames faster than its budget allows', async () => {
    const { first } = await pairedPeers({ maxFramesPerSecond: 4 })

    // The clock does not move, so the bucket never refills: the fifth frame in
    // the same instant is over budget by construction.
    for (let index = 0; index < 5; index += 1) first.send(Buffer.from([index]))

    expect((await first.waitClosed()).code).toBe(CloseCode.RateLimited)
  })

  it('lets a peer keep sending once its budget has refilled', async () => {
    const { first, second } = await pairedPeers({ maxFramesPerSecond: 4 })

    for (let index = 0; index < 4; index += 1) first.send(Buffer.from([index]))
    await second.binary.atLeast(4)
    harness.clock.advance(1000)
    first.send(Buffer.from([4]))

    expect((await second.binary.atLeast(5))[4]?.[0]).toBe(4)
    expect(first.closed.items).toHaveLength(0)
  })

  it('closes a peer sending bytes faster than its budget allows', async () => {
    const { first } = await pairedPeers({
      maxFrameBytes: 4096,
      maxFramesPerSecond: 1000,
      maxBytesPerSecond: 8192
    })

    for (let index = 0; index < 3; index += 1) first.send(Buffer.alloc(4096, index))

    expect((await first.waitClosed()).code).toBe(CloseCode.RateLimited)
  })

  it('closes a peer sending control frames faster than its budget allows', async () => {
    const { first } = await pairedPeers({ maxFramesPerSecond: 4 })

    // A ping is a frame. It costs the relay the same event loop a content frame
    // costs it, so it is charged the same, and the clock does not move: the
    // fifth in the same instant is over budget by construction.
    for (let index = 0; index < 5; index += 1) first.raw(PING_FRAME)

    expect((await first.waitClosed()).code).toBe(CloseCode.RateLimited)
  })

  it('counts a control frame against the byte budget as well as the frame budget', async () => {
    // Two pings' worth of bytes and a thousand frames' worth of frames, so the
    // only budget that can end this connection is the one being tested.
    const { first } = await pairedPeers({ maxFramesPerSecond: 1000, maxBytesPerSecond: 2 * PING_FRAME.length })

    for (let index = 0; index < 3; index += 1) first.raw(PING_FRAME)

    expect((await first.waitClosed()).code).toBe(CloseCode.RateLimited)
  })

  it('closes a peer with no partner at all for flooding control frames', async () => {
    harness = await startTestRelay({ maxFramesPerSecond: 8 })

    // The attack this is here for, in the shape it arrives in: one socket, a
    // hello with any invented token, and pings in a loop. A peer that is merely
    // waiting has no partner, and every rule that measures anything used to
    // measure the partner — so this connection was measured by nothing.
    const lonely = await joinPeer(harness, rendezvousToken())
    for (let index = 0; index < 9; index += 1) lonely.raw(PING_FRAME)

    expect((await lonely.waitClosed()).code).toBe(CloseCode.RateLimited)
  })

  it('drops a peer that cannot keep up rather than buffering without bound', async () => {
    const { first, second } = await pairedPeers({
      maxFrameBytes: 64 * 1024,
      maxFramesPerSecond: 100_000,
      maxBytesPerSecond: 1024 * 1024 * 1024,
      maxBufferedBytes: 256 * 1024
    })

    // A peer that has stopped reading. Its socket stays open and its queue grows;
    // the relay's only alternative to dropping it is to hold that queue forever.
    second.socket.pause()

    const payload = Buffer.alloc(64 * 1024, 3)
    let sent = 0
    while (second.closed.items.length === 0 && first.closed.items.length === 0) {
      expect(sent).toBeLessThan(4096)
      first.send(payload)
      sent += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    second.socket.resume()

    expect((await second.waitClosed()).code).toBe(CloseCode.SlowConsumer)
    expect((await first.waitClosed()).code).toBe(CloseCode.PartnerGone)
  })
})

describe('admission control', () => {
  it('refuses a connection once the relay is at its cap', async () => {
    harness = await startTestRelay({ maxConnections: 2 })
    const token = rendezvousToken()
    await joinPeer(harness, token)
    await joinPeer(harness, token)

    await expect(connectPeer(harness)).rejects.toThrow(/503/)
  })

  it('refuses a single address that holds more connections than its share', async () => {
    harness = await startTestRelay({ maxConnections: 100, maxConnectionsPerAddress: 2 })
    const token = rendezvousToken()
    await joinPeer(harness, token)
    await joinPeer(harness, token)

    await expect(connectPeer(harness)).rejects.toThrow(/429/)
  })

  it('refuses an address that opens connections faster than its budget', async () => {
    harness = await startTestRelay({
      maxConnections: 100,
      maxConnectionsPerAddress: 100,
      maxConnectionsPerAddressPerMinute: 3
    })

    for (let index = 0; index < 3; index += 1) await connectPeer(harness)

    await expect(connectPeer(harness)).rejects.toThrow(/429/)
  })

  it('holds the per-address cap against a burst that arrives all at once', async () => {
    harness = await startTestRelay({ maxConnections: 10_000, maxConnectionsPerAddress: 2 })

    // Sequential arrivals would be admitted one decision at a time. These are
    // offered together, which is the shape that finds out whether the count is
    // taken at the decision or somewhere after it.
    const attempts = await Promise.allSettled(Array.from({ length: 200 }, () => connectPeer(harness)))

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(2)
  })

  it('counts the address a trusted proxy reports rather than the proxy itself', async () => {
    harness = await startTestRelay({
      maxConnections: 100,
      maxConnectionsPerAddress: 1,
      trustedProxyHops: 1
    })

    // Two clients arriving through the same proxy must not share one budget.
    await connectPeer(harness, { 'x-forwarded-for': '198.51.100.7' })
    await connectPeer(harness, { 'x-forwarded-for': '198.51.100.8' })

    await expect(connectPeer(harness, { 'x-forwarded-for': '198.51.100.7' })).rejects.toThrow(/429/)
  })

  it('ignores a forwarded address when no proxy is trusted', async () => {
    harness = await startTestRelay({ maxConnections: 100, maxConnectionsPerAddress: 1 })
    await connectPeer(harness)

    // Without a trusted proxy in front, a client could otherwise mint itself a
    // fresh budget with a header.
    await expect(connectPeer(harness, { 'x-forwarded-for': '198.51.100.9' })).rejects.toThrow(/429/)
  })

  it('serves the relay path and nothing else', async () => {
    harness = await startTestRelay()
    const wrongPath = new WebSocket(`ws://127.0.0.1:${harness.relay.port}/somewhere-else`)

    await expect(
      new Promise((resolve, reject) => {
        wrongPath.once('open', resolve)
        wrongPath.once('error', reject)
      })
    ).rejects.toThrow(/404/)
  })
})

/**
 * The one rule in this file that is driven at the socket port rather than over a
 * real socket. What it is about is a send queue that is already deep, and a
 * kernel on loopback will take several megabytes of twelve-byte pongs before one
 * gets deep — which would make this a test of how a machine is tuned. The port
 * is the interface core is written against, and the host that supplies a real
 * one is covered by the pair of slow-consumer tests above.
 */
describe('the buffer bound, measured at the socket port', () => {
  function lonelyPeer(backlog: () => number) {
    const clock = createManualClock()
    const log = captureLog(clock.now)
    const text: string[] = []
    let closed: { code: number; reason: string } | null = null
    const socket: PeerSocket = {
      isOpen: () => closed === null,
      sendText: (line) => text.push(line),
      sendBinary: () => {},
      backlog,
      close: (code, reason) => {
        closed = { code, reason }
      },
      terminate: () => {
        closed = { code: 1006, reason: '' }
      },
      ping: null
    }
    const host: SessionHost = {
      config: { ...defaultConfig, maxBufferedBytes: 64 * 1024 },
      clock,
      log: log.logger,
      rendezvous: new Rendezvous(),
      onClosed: () => {}
    }
    const session = new PeerSession('peer_lonely', '203.0.113.1', socket, host)
    session.onText(JSON.stringify({ version: 1, rendezvous: rendezvousToken() }))
    return { session, text, closed: () => closed }
  }

  it('answers a peer that is keeping up with its own pongs', () => {
    const peer = lonelyPeer(() => 0)

    peer.session.onText(PING_FRAME)

    expect(peer.text).toContain(PONG_FRAME)
    expect(peer.closed()).toBeNull()
  })

  it('closes a peer that is not reading the answers it asked for', () => {
    const peer = lonelyPeer(() => 64 * 1024 + 1)

    peer.session.onText(PING_FRAME)

    // Not queued, and not dropped in silence either: the relay says why and
    // hangs up, exactly as it does for a peer that stopped reading content.
    expect(peer.text).not.toContain(PONG_FRAME)
    expect(peer.closed()?.code).toBe(CloseCode.SlowConsumer)
  })
})
