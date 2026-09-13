// The Durable Object, run by workerd.
//
// `test/hibernation.test.ts` drives the same adapter against a fake, and says so
// in its first line. A fake is worth having — it is instant and it can be made
// to fail on demand — but it agrees with whatever its author believed, and two
// beliefs in particular were written down as unverified: that a socket's
// attachment can still be read inside `webSocketClose`, and that the identity of
// a `PairSocket` survives a hibernation wake. Both are load-bearing. If either
// is wrong the relay drops frames or leaves a peer waiting forever on a partner
// that has gone.
//
// `wrangler dev` is workerd on localhost. Nothing here is deployed, no account
// is involved and no network resource is created; the runtime is simply the real
// one. So the questions get answered instead of assumed, and the behaviours the
// Node host proves over real sockets get proved here over real sockets too.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CloseCode, PING_FRAME } from '../../src/core/protocol.js'
import { rendezvousToken } from '../support/harness.js'
import {
  announceSkip,
  connectWorkerdPeer,
  delay,
  EVICTION_QUIET_MS,
  joinWorkerdPeer,
  offerWorkerdPeer,
  startWorkerdRelay,
  workerdUnavailable,
  type Offer,
  type WorkerdRelay
} from './support/workerd.js'

const unavailable = workerdUnavailable()
if (unavailable !== null) announceSkip(unavailable)

describe.skipIf(unavailable !== null)('the durable object, run by workerd', () => {
  let relay!: WorkerdRelay

  // The deployed configuration, unchanged: the default alarm interval already
  // leaves the object alone for long enough to be evicted between sweeps, which
  // is the case these tests are here for.
  beforeAll(async () => {
    relay = await startWorkerdRelay()
  }, 120_000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('splices two peers that found each other through a hashed rendezvous name', async () => {
    const token = rendezvousToken()
    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)

    expect(await first.waitPaired()).toMatchObject({ initiator: false })
    expect(await second.waitPaired()).toMatchObject({ initiator: true })

    const payload = Buffer.from([0, 1, 2, 250, 251, 255])
    first.send(payload)
    const [delivered] = await second.binary.atLeast(1)

    expect([...(delivered ?? [])]).toEqual([...payload])
  })

  it('survives a hibernation wake with the pairing intact', async () => {
    const token = rendezvousToken()
    const openedBy = relay.addressRefOnNextOpen()
    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)
    await second.waitPaired()
    const whileResident = await openedBy

    // Long enough for workerd to evict the object, which is the case a pair of
    // teammates is in almost all day. Nothing is holding the sessions now but
    // what the adapter wrote onto each socket.
    await delay(EVICTION_QUIET_MS)

    first.send(Buffer.from([9, 8, 7]))
    const [there] = await second.binary.atLeast(1)
    expect([...(there ?? [])]).toEqual([9, 8, 7])

    second.send(Buffer.from([1]))
    const [back] = await first.binary.atLeast(1)
    expect([...(back ?? [])]).toEqual([1])

    // And the wait above has to have done what it claims, or this test proves
    // nothing at all. A peer arriving now opens against a logger the rebuilt
    // object made, so the label it gets is not the one the pair opened on.
    const openedByRebuilt = relay.addressRefOnNextOpen()
    await connectWorkerdPeer(relay, token)
    expect(await openedByRebuilt).not.toBe(whileResident)
  }, 60_000)

  it('tells a survivor its partner left, from an object rebuilt since they paired', async () => {
    const token = rendezvousToken()
    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)
    await second.waitPaired()

    await delay(EVICTION_QUIET_MS)

    // This is the assumption the adapter's author flagged, in the only shape
    // that matters: the object handling this close never wrote the attachment it
    // is about to read, and the partner is told or it is never told.
    second.socket.terminate()

    expect(await first.waitClosed()).toMatchObject({ code: CloseCode.PartnerGone })
  }, 60_000)

  it('hands a returning peer its own rendezvous back and displaces the pair holding it', async () => {
    const token = rendezvousToken()
    const first = await joinWorkerdPeer(relay, token)
    const stale = await joinWorkerdPeer(relay, token)
    await stale.waitPaired()

    // A laptop that slept: the peer is back before the relay has noticed that
    // its old socket is half dead, and the token it holds is still the token.
    const returning = await joinWorkerdPeer(relay, token)

    expect(await first.waitClosed()).toMatchObject({ code: CloseCode.Superseded })
    expect(await stale.waitClosed()).toMatchObject({ code: CloseCode.Superseded })
    expect(returning.control.items[0]).toEqual({ t: 'waiting' })

    // And the rendezvous still works afterwards, which is the point of letting
    // it be taken over at all.
    const partner = await joinWorkerdPeer(relay, token)
    expect(await partner.waitPaired()).toMatchObject({ initiator: true })
    expect(await returning.waitPaired()).toMatchObject({ initiator: false })
  })

  it('keeps a rendezvous open for its own pair, whatever else is aimed at it', async () => {
    const token = rendezvousToken()
    // Six connections presenting no hello, no token and no proof of anything.
    // The object's name is a hash anybody who has seen the URL may compute, so
    // these cost nothing to open. What they must not buy is the pairing itself:
    // the teammate refused here has no way to tell this from a relay that is not
    // there, and would be told the relay could not be reached.
    const silent: Offer[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) silent.push(await offerWorkerdPeer(relay, token))
    expect(silent.filter((offer) => offer.accepted)).toHaveLength(6)

    // Bounded all the same. Each arrival ends the silent socket that has been
    // here longest, so what one frame costs this object stays fixed however many
    // are offered — the first of these is gone by now.
    const earliest = silent[0]
    expect(earliest?.accepted).toBe(true)
    if (earliest?.accepted === true) {
      // Read in-band rather than waited for as a close, for the reason
      // `deadlines.workerd.test.ts` records: for a socket that never delivered a
      // frame to the object, workerd holds the closing handshake back for about
      // ten seconds after the relay asks for it, and the frame goes out on time.
      const told = await earliest.peer.control.until((frames) => frames.some((frame) => frame.t === 'closing'))
      expect(told.at(-1)).toMatchObject({ t: 'closing', code: CloseCode.Capacity })
    }

    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)
    expect(await second.waitPaired()).toMatchObject({ initiator: true })
    expect(await first.waitPaired()).toMatchObject({ initiator: false })

    for (const offer of silent) if (offer.accepted) offer.peer.close()
  })

  it('turns away a hello that names a rendezvous other than the one in the URL', async () => {
    const token = rendezvousToken()
    const squatter = await connectWorkerdPeer(relay, token)

    // A token nobody but the sender has ever seen. Unchecked, it parks this
    // socket in an object it has no business being in for the whole pairing
    // budget, holding a slot against the pair whose rendezvous names it. The
    // object is `SHA-256(token)`, so the hello has to name the object it landed
    // in — which a peer that derived the one from the other always does.
    squatter.hello(rendezvousToken())

    expect(await squatter.waitClosed()).toMatchObject({ code: CloseCode.BadHello })
  })

  it('answers a peer keepalive without ever waking the object to do it', async () => {
    const token = rendezvousToken()
    const openedBy = relay.addressRefOnNextOpen()
    const peer = await joinWorkerdPeer(relay, token)
    const whileResident = await openedBy

    // The runtime is told the exact bytes to answer, so a peer can hold a NAT
    // mapping open all evening without the object being billed for a wake. If
    // that were not true, these pings would keep it resident and the label a
    // later peer gets would still be this one.
    const until = Date.now() + EVICTION_QUIET_MS
    while (Date.now() < until) {
      peer.raw(PING_FRAME)
      await delay(1_500)
    }
    expect(peer.control.items.filter((frame) => frame.t === 'pong').length).toBeGreaterThan(5)

    const openedByRebuilt = relay.addressRefOnNextOpen()
    await connectWorkerdPeer(relay, token)
    expect(await openedByRebuilt).not.toBe(whileResident)
  }, 60_000)

  it('gives whoever deployed it no way to read what the pair is saying', async () => {
    const token = rendezvousToken()
    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)
    await second.waitPaired()

    const secret = 'not-for-the-person-with-the-cloudflare-account'
    first.send(Buffer.from(secret, 'utf8'))
    await second.binary.atLeast(1)

    // An operator's whole view of this object is the log workerd is printing.
    // In production the payload would be ciphertext; here it is plaintext so
    // that a leak would be legible rather than merely present.
    const logged = relay.log.items.map((record) => JSON.stringify(record)).join('\n')
    expect(logged).not.toContain(secret)
    expect(logged).not.toContain(token)
  })
})
