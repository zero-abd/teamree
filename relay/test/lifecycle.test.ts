// The ugly cases. Peers disappear without saying so, come back before their old
// socket has noticed, arrive hours apart, and occasionally arrive at the same
// instant. None of these is exceptional; they are the normal life of two
// laptops, and the relay has to have an answer to each that is the same every
// time.

import { afterEach, describe, expect, it } from 'vitest'
import { CloseCode } from '../src/core/protocol.js'
import { connectPeer, joinPeer, rendezvousToken, startTestRelay, type TestRelay } from './support/harness.js'

let harness: TestRelay

afterEach(async () => {
  await harness.relay.close()
})

describe('pairing', () => {
  it('pairs the two peers that present the same rendezvous', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()

    const first = await joinPeer(harness, token)
    expect(first.control.items[0]).toEqual({ t: 'waiting' })

    const second = await joinPeer(harness, token)
    const firstPaired = await first.waitPaired()
    const secondPaired = await second.waitPaired()

    expect(firstPaired.session).toBe(secondPaired.session)
    expect(harness.relay.health().sessions).toBe(1)
  })

  it('nominates exactly one side to open the handshake', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)

    // The peer that arrived second is the one that knew a partner was already
    // there, so it is the one told to initiate.
    expect((await first.waitPaired()).initiator).toBe(false)
    expect((await second.waitPaired()).initiator).toBe(true)
  })

  it('pairs two peers that greet in the same instant', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const [a, b] = await Promise.all([connectPeer(harness), connectPeer(harness)])

    a.hello(token)
    b.hello(token)

    const paired = await Promise.all([a.waitPaired(), b.waitPaired()])
    expect(paired[0].session).toBe(paired[1].session)
    expect(paired[0].initiator).not.toBe(paired[1].initiator)
  })

  it('pairs many simultaneous rendezvous without crossing them', async () => {
    harness = await startTestRelay()
    const tokens = Array.from({ length: 12 }, (_, index) => rendezvousToken(`pair-${index}`))
    const peers = await Promise.all(tokens.flatMap((token) => [connectPeer(harness), connectPeer(harness)]))
    peers.forEach((peer, index) => peer.hello(tokens[Math.floor(index / 2)] as string))

    const sessions = await Promise.all(peers.map((peer) => peer.waitPaired()))
    for (let index = 0; index < tokens.length; index += 1) {
      expect(sessions[index * 2]?.session).toBe(sessions[index * 2 + 1]?.session)
    }
    expect(new Set(sessions.map((frame) => frame.session)).size).toBe(tokens.length)
    expect(harness.relay.health().sessions).toBe(tokens.length)
  })

  it('lets a peer park until its partner turns up', async () => {
    harness = await startTestRelay({ pairTimeoutMs: 600_000 })
    const token = rendezvousToken()
    const early = await joinPeer(harness, token)

    // Most of the parking budget goes by with nothing to show for it, which is
    // the normal case for a teammate who is not at their desk yet.
    harness.clock.advance(590_000)
    harness.relay.sweep()
    expect(early.closed.items).toHaveLength(0)
    expect(harness.relay.health().connections.waiting).toBe(1)

    const late = await joinPeer(harness, token)
    expect((await early.waitPaired()).session).toBe((await late.waitPaired()).session)
  })

  it('sends a peer away when nobody has joined it within the pairing budget', async () => {
    harness = await startTestRelay({ pairTimeoutMs: 60_000 })
    const lonely = await joinPeer(harness, rendezvousToken())

    harness.clock.advance(60_000)
    harness.relay.sweep()

    const closed = await lonely.waitClosed()
    expect(closed.code).toBe(CloseCode.PairTimeout)
  })
})

describe('sessions that end badly', () => {
  it('tells the survivor when its partner vanishes without closing', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    // No close frame, no warning: the laptop went into a bag.
    second.socket.terminate()

    const closed = await first.waitClosed()
    expect(closed.code).toBe(CloseCode.PartnerGone)
    expect(harness.relay.health().sessions).toBe(0)
  })

  it('lets a returning peer take over a rendezvous its half-open predecessor still holds', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const stale = await joinPeer(harness, token)
    await first.waitPaired()

    // A suspended machine's socket reads as open for as long as the network
    // lets it. Pausing stands in for that: the peer is present and useless.
    stale.socket.pause()

    const returning = await joinPeer(harness, token)

    expect((await first.waitClosed()).code).toBe(CloseCode.Superseded)
    expect(returning.control.items[0]).toEqual({ t: 'waiting' })

    // And the pair rebuilds from scratch, which is all a dead Noise session
    // allows anyway.
    const reconnected = await joinPeer(harness, token)
    expect((await returning.waitPaired()).session).toBe((await reconnected.waitPaired()).session)
  })

  it('distinguishes being superseded from a partner that simply left', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    await joinPeer(harness, token)

    // Two reconnecting peers that could not tell these apart would spend the
    // evening displacing one another.
    expect((await first.waitClosed()).code).toBe(CloseCode.Superseded)
    expect((await second.waitClosed()).code).toBe(CloseCode.Superseded)
    expect(CloseCode.Superseded).not.toBe(CloseCode.PartnerGone)
  })

  it('does not let a superseded peer evict the connection that replaced it', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    const replacement = await joinPeer(harness, token)
    await first.waitClosed()
    await second.waitClosed()

    // The old pair's close events land after the new registration exists, and
    // the table has to know they are not about it.
    expect(harness.relay.health().connections.waiting).toBe(1)
    const partner = await joinPeer(harness, token)
    expect((await replacement.waitPaired()).session).toBe((await partner.waitPaired()).session)
  })

  it('closes a paired session that has said nothing within the idle budget', async () => {
    harness = await startTestRelay({ idleTimeoutMs: 120_000 })
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    harness.clock.advance(120_000)
    harness.relay.sweep()

    expect((await first.waitClosed()).code).toBe(CloseCode.Idle)
    expect((await second.waitClosed()).code).not.toBe(1006)
  })

  it('keeps a session that is still carrying content', async () => {
    harness = await startTestRelay({ idleTimeoutMs: 120_000 })
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    harness.clock.advance(119_000)
    first.send(Buffer.from('still here'))
    await second.binary.atLeast(1)
    harness.clock.advance(119_000)
    harness.relay.sweep()

    expect(first.closed.items).toHaveLength(0)
    expect(second.closed.items).toHaveLength(0)
  })
})

describe('keepalives', () => {
  it('keeps a peer that is quiet but still answering', async () => {
    harness = await startTestRelay({ keepaliveIntervalMs: 30_000, idleTimeoutMs: 0 })
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    harness.clock.advance(30_000)
    harness.relay.sweep()
    await Promise.all([first.pings.atLeast(1), second.pings.atLeast(1)])

    // Each peer answers a ping before anything it sends afterwards, on the same
    // socket and so in that order: a frame that has arrived is proof the answer
    // was taken in first.
    first.send(Buffer.from([1]))
    second.send(Buffer.from([2]))
    await Promise.all([second.binary.atLeast(1), first.binary.atLeast(1)])

    harness.clock.advance(30_000)
    harness.relay.sweep()

    expect(first.closed.items).toHaveLength(0)
    expect(second.closed.items).toHaveLength(0)
  })

  it('cuts a peer whose socket is open but no longer listening', async () => {
    harness = await startTestRelay({ keepaliveIntervalMs: 30_000, idleTimeoutMs: 0 })
    const peer = await joinPeer(harness, rendezvousToken())

    // A NAT that forgot the mapping leaves exactly this: a socket that still
    // reads as open and will never say anything again.
    peer.socket.pause()
    harness.clock.advance(30_000)
    harness.relay.sweep()
    harness.clock.advance(30_000)
    harness.relay.sweep()
    peer.socket.resume()

    await peer.closed.atLeast(1)
    expect(harness.log.records.some((record) => record.event === 'peer.unresponsive')).toBe(true)
  })
})

describe('greeting', () => {
  it('hangs up on a connection that opens and says nothing', async () => {
    harness = await startTestRelay({ helloTimeoutMs: 10_000 })
    const silent = await connectPeer(harness)

    harness.clock.advance(10_000)
    harness.relay.sweep()

    expect((await silent.waitClosed()).code).toBe(CloseCode.BadHello)
  })

  it.each([
    ['not JSON at all', 'hello there'],
    ['a JSON array', '[]'],
    ['a version it does not speak', JSON.stringify({ version: 99, rendezvous: rendezvousToken() })],
    ['a rendezvous of the wrong shape', JSON.stringify({ version: 1, rendezvous: 'short' })],
    ['a rendezvous that is not hex', JSON.stringify({ version: 1, rendezvous: 'Z'.repeat(64) })],
    ['no rendezvous at all', JSON.stringify({ version: 1 })]
  ])('hangs up on a hello that is %s', async (_description, greeting) => {
    harness = await startTestRelay()
    const peer = await connectPeer(harness)

    peer.raw(greeting)

    expect((await peer.waitClosed()).code).toBe(CloseCode.BadHello)
  })

  it('ignores fields it does not know rather than rejecting a newer peer', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const peer = await connectPeer(harness)

    peer.raw(JSON.stringify({ version: 1, rendezvous: token, somethingLater: { nested: true } }))

    expect((await peer.control.atLeast(1))[0]).toEqual({ t: 'waiting' })
  })

  it('hangs up on a peer that keeps talking in control frames after its hello', async () => {
    harness = await startTestRelay()
    const peer = await joinPeer(harness, rendezvousToken())

    peer.raw(JSON.stringify({ t: 'something' }))

    expect((await peer.waitClosed()).code).toBe(CloseCode.Protocol)
  })
})
