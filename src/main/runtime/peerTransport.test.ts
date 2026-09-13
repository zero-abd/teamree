// The fourth transport, on its own, with the Noise session real and the relay
// replaced by handing one side's bytes straight to the other.
//
// Two things are being protected here and both are about a caller who is not
// the user. The first is the allow-list: a teammate reaches the catalogue, not
// all of it, and the line between the two is a list rather than a judgement
// made per handler. The second is framing: a Noise transport message is capped
// at 65535 bytes and carries no length, so an application message larger than
// that has to be cut and put back together exactly, or the session ends.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createInitiatorSession, createResponderSession, generateStaticKeyPair } from '../../shared/peer'
import type { PeerSession } from '../../shared/peer'
import { ErrorCode } from '../../shared/protocol'
import { createDispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import { createPeerTransport, PEER_METHODS, type PeerTransport } from './peerTransport'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'

/** Two halves of one completed IK handshake, with nothing in between. */
function handshakenPair(): [PeerSession, PeerSession] {
  const initiatorKeys = generateStaticKeyPair()
  const responderKeys = generateStaticKeyPair()
  const initiator = createInitiatorSession({
    staticPrivateKey: initiatorKeys.privateKey,
    remoteStaticPublicKey: responderKeys.publicKey
  })
  const responder = createResponderSession({
    staticPrivateKey: responderKeys.privateKey,
    isAuthorisedPeer: () => true
  })
  responder.readHandshakeMessage(initiator.writeHandshakeMessage())
  initiator.readHandshakeMessage(responder.writeHandshakeMessage())
  return [initiator, responder]
}

type Rig = {
  /** The transport a teammate's runtime would have. */
  caller: PeerTransport
  /** The transport answering on this machine, with the registry behind it. */
  answerer: PeerTransport
  registry: MethodRegistry
  hub: SubscriptionHub
}

/**
 * Two transports wired mouth to ear.
 *
 * Delivery is synchronous, which is exactly what a WebSocket is not — but the
 * property under test is message boundaries, and a queue between them would
 * only prove the queue kept order.
 */
function rig(allowedMethods?: readonly Parameters<MethodRegistry['register']>[0][]): Rig {
  const [callerSession, answererSession] = handshakenPair()
  const hub = new SubscriptionHub()
  const registry = new MethodRegistry(createRuntimeContext({ version: 't', store: {} as never, subscriptions: hub }))

  registry.register('status.get', z.object({}), () => ({
    version: 't',
    endpoint: '',
    pid: 1,
    platform: 'linux' as NodeJS.Platform,
    startedAt: 0
  }))
  registry.register('peer.presence', z.object({}), () => ({ revision: 1, handle: 'them', projects: [] }))
  registry.register('worktree.remove', z.object({ worktreeId: z.string() }), () => ({ removed: true as const }))

  let answerer: PeerTransport
  const caller = createPeerTransport({
    session: callerSession,
    send: (message) => answerer.receive(message),
    dispatch: createDispatcher(
      new MethodRegistry(
        createRuntimeContext({ version: 't', store: {} as never, subscriptions: new SubscriptionHub() })
      )
    ),
    subscriptions: new SubscriptionHub(),
    connectionId: 'peer_caller',
    onFatal: () => {}
  })
  answerer = createPeerTransport({
    session: answererSession,
    send: (message) => caller.receive(message),
    dispatch: createDispatcher(registry),
    subscriptions: hub,
    connectionId: 'peer_answerer',
    ...(allowedMethods ? { allowedMethods } : {}),
    onFatal: () => {}
  })

  return { caller, answerer, registry, hub }
}

describe('what a teammate can reach', () => {
  it('answers a method on the peer allow-list', async () => {
    const { caller } = rig()
    await expect(caller.call('peer.presence', {})).resolves.toMatchObject({ revision: 1 })
  })

  it('refuses a method that is registered but not a teammate’s to call', async () => {
    const { caller } = rig()
    // Registered, reachable over IPC and over the CLI socket, and not this.
    // "Everyone sees everything" is about panes, not about deleting somebody's
    // afternoon from two thousand miles away.
    await expect(caller.call('worktree.remove', { worktreeId: 'wt_1' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
  })

  it('does not stream terminal output in this milestone', () => {
    // The seam for milestone C, asserted so that widening it is a deliberate
    // edit to one list and not a side effect of registering a handler.
    expect(PEER_METHODS).not.toContain('terminal.subscribe')
    expect(PEER_METHODS).not.toContain('terminal.read')
    expect(PEER_METHODS).not.toContain('terminal.write')
    expect([...PEER_METHODS]).toEqual(['peer.presence', 'peer.subscribe', 'unsubscribe'])
  })

  it('widens by exactly the list it is given, which is how C plugs in', async () => {
    const { caller } = rig(['peer.presence', 'status.get'])
    await expect(caller.call('status.get', {})).resolves.toMatchObject({ version: 't' })
  })
})

describe('framing', () => {
  it('carries a message far larger than one Noise transport message', async () => {
    const { caller, registry } = rig(['peer.presence'])
    // Well past the 65535-byte ceiling, so it has to be cut and reassembled.
    const huge = 'x'.repeat(400_000)
    registry.register('peer.presence', z.object({}), () => ({
      revision: 1,
      handle: huge,
      projects: []
    }))
    const answer = await caller.call('peer.presence', {})
    expect(answer.handle).toHaveLength(400_000)
  })

  it('keeps a multi-byte character whole across a chunk boundary', async () => {
    const { caller, registry } = rig(['peer.presence'])
    // Four-byte characters, in a string long enough that a boundary lands
    // inside one of them — decoded eagerly that becomes U+FFFD and never
    // comes back.
    const emoji = '🛠'.repeat(40_000)
    registry.register('peer.presence', z.object({}), () => ({ revision: 1, handle: emoji, projects: [] }))
    const answer = await caller.call('peer.presence', {})
    expect(answer.handle).toBe(emoji)
  })

  it('ends the link when a message does not authenticate, rather than carrying on', () => {
    const [session] = handshakenPair()
    let fatal: string | undefined
    const transport = createPeerTransport({
      session,
      send: () => {},
      dispatch: createDispatcher(
        new MethodRegistry(
          createRuntimeContext({ version: 't', store: {} as never, subscriptions: new SubscriptionHub() })
        )
      ),
      subscriptions: new SubscriptionHub(),
      connectionId: 'peer_x',
      onFatal: (reason) => {
        fatal = reason
      }
    })

    // Forged, or reordered, or replayed. Noise transport has no nonce on the
    // wire and no replay window, so all three look the same and all three mean
    // the stream can no longer be trusted or resynchronised.
    transport.receive(new Uint8Array(64))
    expect(fatal).toBeTruthy()
  })
})

describe('subscriptions a teammate opened', () => {
  it('releases them when the link ends, so nothing outlives the machine that asked', async () => {
    const { caller, answerer, hub, registry } = rig(['peer.subscribe'])
    registry.register('peer.subscribe', z.object({}), (_params, call) => ({
      subscription: hub.subscribe(call.connectionId, () => () => {})
    }))

    await caller.call('peer.subscribe', {})
    expect(hub.countFor('peer_answerer')).toBe(1)

    answerer.close('the teammate went away')
    expect(hub.countFor('peer_answerer')).toBe(0)
  })
})
