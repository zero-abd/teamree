// The owner's peer transport with an attacker on the far end, for the tests in
// this directory that are about what the transport itself refuses.
//
// The Noise session and the framing are the real ones; only the relay is gone,
// because what is under test is what the runtime does with the plaintext. The
// attacker frames its own bytes rather than using a transport, so it can put as
// many requests in one Noise message as fit — which is the whole point of
// several of these tests.
//
// Not a `.test.ts`, so vitest does not collect it as a suite of its own.

import { Params } from '../../src/shared/methods'
import { createInitiatorSession, createResponderSession, generateStaticKeyPair } from '../../src/shared/peer'
import type { PeerSession } from '../../src/shared/peer'
import { createDispatcher } from '../../src/main/runtime/dispatcher'
import { MethodRegistry } from '../../src/main/runtime/methodRegistry'
import { encodeLine } from '../../src/main/runtime/peerFraming'
import {
  createPeerTransport,
  type RemoteWriteRequest,
  type RemoteWriteVerdict
} from '../../src/main/runtime/peerTransport'
import { createRuntimeContext } from '../../src/main/runtime/runtimeContext'
import { SubscriptionHub } from '../../src/main/runtime/subscriptionHub'

export function handshakenPair(): [PeerSession, PeerSession] {
  const attacker = generateStaticKeyPair()
  const owner = generateStaticKeyPair()
  const initiator = createInitiatorSession({
    staticPrivateKey: attacker.privateKey,
    remoteStaticPublicKey: owner.publicKey
  })
  const responder = createResponderSession({
    staticPrivateKey: owner.privateKey,
    isAuthorisedPeer: () => true
  })
  responder.readHandshakeMessage(initiator.writeHandshakeMessage())
  initiator.readHandshakeMessage(responder.writeHandshakeMessage())
  return [initiator, responder]
}

export type OwnerRig = {
  /** Everything the owner's runtime wrote back to the teammate, decoded. */
  replies: () => unknown[]
  /** One relay frame carrying whatever lines the attacker wants in it. */
  sendRaw: (lines: readonly string[]) => void
  /** Requests that reached the dispatcher, which is the owner's main thread working. */
  dispatched: () => number
  /** Every write the owner's verdict was asked about, in order. */
  judged: () => readonly RemoteWriteRequest[]
  /** Everything that actually reached the pane. */
  written: () => readonly string[]
  /** The subscription channel a `terminal.subscribe` opened, by pane. */
  pane: (terminalId: string) => { emit: (event: unknown) => void; close: () => void } | undefined
  held: () => number
  /**
   * The panes the transport last told the owner this teammate has open.
   *
   * The exact seam the owner's "watched by" row is fed from: `PeerService`
   * keeps nothing of its own about who is reading, it files whatever arrives
   * here. So a test that wants to know what the owner would be shown asks this
   * rather than reaching for a window.
   */
  watched: () => readonly string[]
  /** Every scrollback read the dispatcher answered, in order. */
  reads: () => readonly string[]
}

export function ownerRig(): OwnerRig {
  const [attackerSession, ownerSession] = handshakenPair()
  const hub = new SubscriptionHub()
  const panes = new Map<string, { emit: (event: unknown) => void; close: () => void }>()
  const registry = new MethodRegistry(createRuntimeContext({ version: 't', store: {} as never, subscriptions: hub }))
  const written: string[] = []
  const judged: RemoteWriteRequest[] = []
  const reads: string[] = []
  let watched: readonly string[] = []
  let dispatched = 0

  registry.register('terminal.write', Params.terminalWrite, (params) => {
    written.push(params.data)
    return { written: true as const }
  })
  // The scrollback a watcher joins on. Answered out of a buffer on the real
  // machine, and here out of nothing at all, because what these tests ask of it
  // is whether it was answered and what the owner was told about it.
  registry.register('terminal.read', Params.terminalRead, (params) => {
    reads.push(params.terminalId)
    return { data: '' }
  })
  registry.register('terminal.subscribe', Params.terminalSubscribe, (params, call) => ({
    subscription: hub.subscribe(call.connectionId, (channel) => {
      panes.set(params.terminalId, channel)
      return () => panes.delete(params.terminalId)
    })
  }))
  registry.register('unsubscribe', Params.unsubscribe, (params, call) => ({
    unsubscribed: hub.unsubscribe(call.connectionId, params.subscription) as true
  }))

  const inner = createDispatcher(registry)
  const replies: unknown[] = []
  let tail = ''

  const owner = createPeerTransport({
    session: ownerSession,
    // Decrypted straight back into text, so the attacker sees the answers the
    // way its own line reader would.
    send: (message) => {
      tail += Buffer.from(attackerSession.decrypt(message)).toString('utf8')
      for (;;) {
        const newline = tail.indexOf('\n')
        if (newline === -1) break
        const line = tail.slice(0, newline).trim()
        tail = tail.slice(newline + 1)
        if (line) replies.push(JSON.parse(line))
      }
    },
    dispatch: (value, call) => {
      dispatched += 1
      return inner(value, call)
    },
    subscriptions: hub,
    connectionId: 'peer_owner',
    onRemoteRead: () => ({ ok: true }),
    onRemoteWrite: (write): RemoteWriteVerdict => {
      judged.push(write)
      return { ok: true }
    },
    onWatchChange: (terminalIds) => {
      watched = terminalIds
    },
    onFatal: () => {}
  })

  return {
    replies: () => replies,
    sendRaw: (lines) => {
      for (const message of encodeLine(attackerSession, `${lines.join('\n')}\n`)) owner.receive(message)
    },
    dispatched: () => dispatched,
    judged: () => judged,
    written: () => written,
    pane: (terminalId) => panes.get(terminalId),
    held: () => hub.countFor('peer_owner'),
    watched: () => watched,
    reads: () => reads
  }
}

/** Several turns, because a dispatch is a promise chain and the reply is written in its continuation. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 64; turn += 1) await Promise.resolve()
}

/** The refusals among a run of answers, by the code they carry. */
export function refusalsOf(replies: readonly unknown[]): { id: string; code: string; message: string }[] {
  return replies
    .filter(
      (frame): frame is { id: string; ok: false; error: { code: string; message: string } } =>
        (frame as { ok?: unknown }).ok === false
    )
    .map((frame) => ({ id: frame.id, code: frame.error.code, message: frame.error.message }))
}
