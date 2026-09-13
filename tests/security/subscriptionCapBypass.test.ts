// FIXED: the subscription cap held by accident, and now holds by construction.
//
// `peerTransport.handleRequest` refuses a subscribing method when the peer
// already holds `MAX_PEER_SUBSCRIPTIONS`. The check is synchronous; the count
// it used to read was `options.subscriptions.countFor(...)`, which is only
// moved by `hub.subscribe` — and that happens inside the handler, behind an
// `async` dispatcher. One Noise transport message is a byte stream of
// newline-delimited JSON and `receive` routes the whole batch in a synchronous
// loop, so if the count moved a task later than the check, every request in one
// relay frame would read the same stale zero and the cap would be per-frame
// rather than per-link.
//
// It did not, and the reason was narrow: `createDispatcher` evaluates
// `entry.handler(params, call)` before awaiting it, and neither reachable
// subscribing handler awaited anything before it called `hub.subscribe`:
//
//     'terminal.subscribe': async (params, call) => { ...
//        subscription: hub.subscribe(call.connectionId, ...) }   // no await above
//     'peer.subscribe': (_params, call) => ({
//        subscription: registry.context.subscriptions.subscribe(...) })
//
// So one `await` added anywhere above those calls — a permission read, a config
// load, an `await manager.ready()` — would have silently converted a bound on
// main-process memory into no bound at all, with no test anywhere else failing.
//
// The slot is now taken at the check instead of counted out of the hub:
// `handleRequest` reserves it synchronously and gives it back when the answer
// says the subscription was never minted. The two tests below are the same
// handler a microtask apart, and the cap holds for both.

import { describe, expect, it } from 'vitest'
import { Params } from '../../src/shared/methods'
import { createInitiatorSession, createResponderSession, generateStaticKeyPair } from '../../src/shared/peer'
import type { PeerSession } from '../../src/shared/peer'
import { createDispatcher } from '../../src/main/runtime/dispatcher'
import { MethodRegistry } from '../../src/main/runtime/methodRegistry'
import { encodeLine } from '../../src/main/runtime/peerFraming'
import { createPeerTransport, MAX_PEER_SUBSCRIPTIONS } from '../../src/main/runtime/peerTransport'
import { createRuntimeContext } from '../../src/main/runtime/runtimeContext'
import { SubscriptionHub } from '../../src/main/runtime/subscriptionHub'

async function settle(): Promise<void> {
  for (let turn = 0; turn < 64; turn += 1) await Promise.resolve()
}

function handshakenPair(): [PeerSession, PeerSession] {
  const attacker = generateStaticKeyPair()
  const owner = generateStaticKeyPair()
  const initiator = createInitiatorSession({
    staticPrivateKey: attacker.privateKey,
    remoteStaticPublicKey: owner.publicKey
  })
  const responder = createResponderSession({ staticPrivateKey: owner.privateKey, isAuthorisedPeer: () => true })
  responder.readHandshakeMessage(initiator.writeHandshakeMessage())
  initiator.readHandshakeMessage(responder.writeHandshakeMessage())
  return [initiator, responder]
}

/**
 * The owner's transport with one subscribing handler behind it.
 *
 * `awaitsFirst` is the whole experiment: the same handler, doing the same
 * thing, one microtask later.
 */
function rig(awaitsFirst: boolean): {
  sendRaw: (lines: readonly string[]) => void
  held: () => number
} {
  const [attackerSession, ownerSession] = handshakenPair()
  const hub = new SubscriptionHub()
  const registry = new MethodRegistry(createRuntimeContext({ version: 't', store: {} as never, subscriptions: hub }))

  registry.register('terminal.subscribe', Params.terminalSubscribe, async (_params, call) => {
    // The real handler is `async` and calls `hub.subscribe` before awaiting
    // anything, which is what keeps the cap honest. This is the one-line
    // difference.
    if (awaitsFirst) await Promise.resolve()
    return { subscription: hub.subscribe(call.connectionId, () => () => {}) }
  })
  registry.register('unsubscribe', Params.unsubscribe, (params, call) => ({
    unsubscribed: hub.unsubscribe(call.connectionId, params.subscription) as true
  }))

  const owner = createPeerTransport({
    session: ownerSession,
    send: (message) => void attackerSession.decrypt(message),
    dispatch: createDispatcher(registry),
    subscriptions: hub,
    connectionId: 'peer_owner',
    onRemoteRead: () => ({ ok: true }),
    onFatal: () => {}
  })

  return {
    sendRaw: (lines) => {
      for (const message of encodeLine(attackerSession, `${lines.join('\n')}\n`)) owner.receive(message)
    },
    held: () => hub.countFor('peer_owner')
  }
}

const subscribe = (n: number): string =>
  JSON.stringify({ id: `s${n}`, method: 'terminal.subscribe', params: { terminalId: 't1' } })

const burst = (count: number): string[] => Array.from({ length: count }, (_unused, n) => subscribe(n))

describe('the cap on how many streams one teammate may hold', () => {
  it('holds against a pipelined burst', async () => {
    const owner = rig(false)
    owner.sendRaw(burst(800))
    await settle()
    expect(owner.held()).toBe(MAX_PEER_SUBSCRIPTIONS)
  })

  it('ATTACK: holds even when a subscribing handler awaits before it subscribes', async () => {
    const owner = rig(true)
    owner.sendRaw(burst(800))
    await settle()

    // The same handler, one microtask later, and the same answer. Every request
    // in the frame used to read a count of zero here, because the count only
    // moved once the handler got to `hub.subscribe`; the slot is taken at the
    // check now, so what a later `await` changes is when the subscription
    // appears and never how many of them there may be.
    expect(owner.held()).toBe(MAX_PEER_SUBSCRIPTIONS)
  })

  it('gives a slot back when the subscribe it was taken for is released', async () => {
    // The reservation is not a one-way ratchet: a teammate who closes a pane
    // can open another, which is the ordinary thing a watcher does all day.
    const owner = rig(true)
    owner.sendRaw(burst(MAX_PEER_SUBSCRIPTIONS))
    await settle()
    expect(owner.held()).toBe(MAX_PEER_SUBSCRIPTIONS)

    owner.sendRaw([JSON.stringify({ id: 'u', method: 'unsubscribe', params: { subscription: 'sub_1' } })])
    await settle()
    expect(owner.held()).toBe(MAX_PEER_SUBSCRIPTIONS - 1)

    owner.sendRaw([subscribe(900)])
    await settle()
    expect(owner.held()).toBe(MAX_PEER_SUBSCRIPTIONS)
  })
})
