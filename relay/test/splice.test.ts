// The splice, over real sockets. These are the tests that protect the one
// property the whole design rests on: what a peer sends is what its partner
// receives, and the relay neither reads it nor is able to.

import { afterEach, describe, expect, it } from 'vitest'
import { connectPeer, joinPeer, rendezvousToken, startTestRelay, type TestRelay } from './support/harness.js'

let harness: TestRelay

afterEach(async () => {
  await harness.relay.close()
})

describe('splicing two peers together', () => {
  it('delivers a peer bytes to its partner unchanged', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    // Every byte value, so nothing can be lost to an encoding assumption.
    const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
    first.send(payload)

    const received = await second.binary.atLeast(1)
    expect(received[0]).toEqual(payload)
  })

  it('carries traffic in both directions and keeps each side in order', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    for (let index = 0; index < 20; index += 1) first.send(Buffer.from([index]))
    for (let index = 0; index < 20; index += 1) second.send(Buffer.from([100 + index]))

    const toSecond = await second.binary.atLeast(20)
    const toFirst = await first.binary.atLeast(20)
    expect(toSecond.map((frame) => frame[0])).toEqual(Array.from({ length: 20 }, (_, index) => index))
    expect(toFirst.map((frame) => frame[0])).toEqual(Array.from({ length: 20 }, (_, index) => 100 + index))
  })

  it('forwards a payload shaped like a control frame without acting on it', async () => {
    harness = await startTestRelay()
    const token = rendezvousToken()
    const first = await joinPeer(harness, token)
    const second = await joinPeer(harness, token)
    await first.waitPaired()

    // A relay that parsed content would find an instruction here. This one sees
    // a length and a destination.
    const impostor = Buffer.from(JSON.stringify({ t: 'closing', code: 4001, reason: 'partner disconnected' }))
    first.send(impostor)

    const received = await second.binary.atLeast(1)
    expect(received[0]).toEqual(impostor)
    expect(second.closed.items).toHaveLength(0)
    expect(second.control.items.filter((frame) => frame.t === 'closing')).toHaveLength(0)
  })

  it('keeps pairs on different rendezvous from ever seeing each other', async () => {
    harness = await startTestRelay()
    const left = rendezvousToken('left')
    const right = rendezvousToken('right')
    const leftA = await joinPeer(harness, left)
    const leftB = await joinPeer(harness, left)
    const rightA = await joinPeer(harness, right)
    const rightB = await joinPeer(harness, right)
    await Promise.all([leftA.waitPaired(), rightA.waitPaired()])

    leftA.send(Buffer.from('left'))
    rightA.send(Buffer.from('right'))

    expect((await leftB.binary.atLeast(1))[0]?.toString()).toBe('left')
    expect((await rightB.binary.atLeast(1))[0]?.toString()).toBe('right')
    expect(leftA.binary.items).toHaveLength(0)
    expect(rightA.binary.items).toHaveLength(0)
  })

  it('refuses to carry content from a peer that has not been paired yet', async () => {
    harness = await startTestRelay()
    const lonely = await joinPeer(harness, rendezvousToken())

    lonely.send(Buffer.from('too early'))

    const closed = await lonely.waitClosed()
    expect(closed.code).toBe(4008)
  })

  it('refuses to carry content from a peer that never said hello', async () => {
    harness = await startTestRelay()
    const silent = await connectPeer(harness)

    silent.send(Buffer.from('no greeting'))

    const closed = await silent.waitClosed()
    expect(closed.code).toBe(4008)
  })
})
