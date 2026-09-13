// The limits, which are the difference between a relay a team can leave running
// and one that a single misbehaving client takes down. Every budget here is
// driven by the injected clock, so "over the budget" is an arithmetic fact
// rather than a race against the test runner.

import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { CloseCode } from '../src/core/protocol.js'
import { connectPeer, joinPeer, rendezvousToken, startTestRelay, type TestRelay } from './support/harness.js'

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
