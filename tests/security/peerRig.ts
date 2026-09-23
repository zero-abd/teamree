// The owner's peer transport with an attacker on the far end: real Noise session and framing, no relay.
// The attacker frames its own bytes so it can pack many requests into one message. Not a `.test.ts`.

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
  /** The panes the transport last reported this teammate has open, the seam the "watched by" row reads. */
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
  // Answered out of nothing: the tests ask only whether it was answered and what the owner was told.
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
    // Decrypted back to text, as the attacker's own line reader would see it.
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
