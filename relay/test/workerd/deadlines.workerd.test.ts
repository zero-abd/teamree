// The relay's deadlines, enforced by workerd's alarm rather than by a sweep this
// process drives.
//
// On the container host a test advances a manual clock and calls `sweep()`, so
// the result is the same every run. There is no equivalent here: the alarm is
// the runtime's, it fires when it decides to, and the only way to see a deadline
// pass is to wait for it. So the deadlines are configured down to a few seconds
// and the tests wait them out — which is slow, and is the price of finding out
// whether the alarm fires at all on the runtime that will be running it.
//
// The keepalive is the interesting one. On this host a peer's ping is answered
// by the runtime without the object being woken, which means the object is
// rebuilt with no memory of it ever arriving. The only trace is a timestamp the
// runtime kept, and if the adapter did not read it back the alarm would reap a
// pair that had been doing exactly what the relay documents.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CloseCode, PING_FRAME } from '../../src/core/protocol.js'
import { rendezvousToken } from '../support/harness.js'
import {
  announceSkip,
  connectWorkerdPeer,
  delay,
  EVICTION_QUIET_MS,
  joinWorkerdPeer,
  startWorkerdRelay,
  workerdUnavailable,
  type WorkerdRelay
} from './support/workerd.js'

/** Short enough to wait out, long enough that a busy machine cannot trip it. */
const IDLE_TIMEOUT_MS = 6_000
const ALARM_INTERVAL_MS = 2_000

// The shortest the relay accepts for each, so a silent socket is closed on the first alarm.
const SILENT_HELLO_TIMEOUT_MS = 1_000
const SILENT_ALARM_INTERVAL_MS = 1_000

const unavailable = workerdUnavailable()
if (unavailable !== null) announceSkip(unavailable)

describe.skipIf(unavailable !== null)('the durable object alarm, run by workerd', () => {
  let relay!: WorkerdRelay

  beforeAll(async () => {
    relay = await startWorkerdRelay({
      RELAY_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      RELAY_PAIR_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      RELAY_KEEPALIVE_INTERVAL_MS: String(ALARM_INTERVAL_MS)
    })
  }, 120_000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('reaps a silent pair on the alarm and tells both halves the same true thing', async () => {
    const token = rendezvousToken()
    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)
    await second.waitPaired()

    // Neither of them disconnected — they were both quiet — so neither may be
    // told the other left.
    expect(await first.waitClosed()).toMatchObject({ code: CloseCode.Idle })
    expect(await second.waitClosed()).toMatchObject({ code: CloseCode.Idle })
  }, 30_000)

  it('keeps a pair alive on nothing but the keepalive the runtime answered for it', async () => {
    const token = rendezvousToken()
    const first = await joinWorkerdPeer(relay, token)
    const second = await joinWorkerdPeer(relay, token)
    await second.waitPaired()

    // Twice the idle budget, with no content in either direction: the only
    // thing keeping this session is a ping the object was never handed.
    const until = Date.now() + IDLE_TIMEOUT_MS * 2
    while (Date.now() < until) {
      first.raw(PING_FRAME)
      second.raw(PING_FRAME)
      await delay(IDLE_TIMEOUT_MS / 4)
    }

    expect(first.closed.items).toEqual([])
    expect(second.closed.items).toEqual([])
    expect(first.control.items.some((frame) => frame.t === 'pong')).toBe(true)
  }, 40_000)

  it('sends an unpaired peer away when nobody ever joins it', async () => {
    const lonely = await joinWorkerdPeer(relay, rendezvousToken())
    expect(lonely.control.items[0]).toEqual({ t: 'waiting' })

    expect(await lonely.waitClosed()).toMatchObject({ code: CloseCode.PairTimeout })
  }, 30_000)

  it('stops waking itself once the rendezvous it was holding is empty', async () => {
    const token = rendezvousToken()
    const openedBy = relay.addressRefOnNextOpen()
    const peer = await joinWorkerdPeer(relay, token)
    const whileResident = await openedBy

    peer.close()
    await peer.waitClosed()

    // Long enough that an object nothing is waking would have been evicted
    // several times over. An alarm that re-arms whether or not there is anything
    // left to sweep would hold this object in memory for as long as the account
    // exists, once per rendezvous anyone ever used, and the operator paying for
    // that is a team rather than us.
    await delay(EVICTION_QUIET_MS)

    const openedAgain = relay.addressRefOnNextOpen()
    await connectWorkerdPeer(relay, token)
    expect(await openedAgain).not.toBe(whileResident)
  }, 60_000)
})

describe.skipIf(unavailable !== null)('the hello deadline, run by workerd', () => {
  let relay!: WorkerdRelay

  // Its own server: at a one-second hello deadline, a loaded machine could close the joins above.
  beforeAll(async () => {
    relay = await startWorkerdRelay({
      RELAY_HELLO_TIMEOUT_MS: String(SILENT_HELLO_TIMEOUT_MS),
      RELAY_KEEPALIVE_INTERVAL_MS: String(SILENT_ALARM_INTERVAL_MS)
    })
  }, 120_000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('closes a connection that opened and then said nothing at all', async () => {
    // The one deadline armed by the upgrade itself: there is no frame to arm it.
    const silent = await connectWorkerdPeer(relay, rendezvousToken())

    const closed = await silent.waitClosed()
    // The in-band frame goes out ahead of the close frame, so it is already here.
    expect(silent.control.items.at(-1)).toMatchObject({ t: 'closing', code: CloseCode.BadHello })
    expect(closed).toMatchObject({ code: CloseCode.BadHello })
  }, 45_000)
})
