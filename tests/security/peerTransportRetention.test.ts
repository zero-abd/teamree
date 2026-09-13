// FIXED: a teammate could make the runtime retain unbounded attacker-chosen
// memory, and could make one relay frame cost the runtime hundreds of
// dispatches. These tests are the attack, and they now assert that it fails.
//
// `peerTransport.handleRequest` keeps a set of the subscription ids the peer
// has asked to release:
//
//     if (method === 'unsubscribe') {
//       const subscription = subscriptionOf(value)
//       if (subscription !== undefined) releasing.add(subscription)
//     }
//
// It was added *before* the dispatch, so nothing the dispatcher or
// `Params.unsubscribe` would say about the id had happened yet — and the only
// place anything was ever removed from it is the subscription-ended callback:
//
//     const asked = releasing.delete(subscriptionId)
//
// An id that named no subscription therefore stayed in the set for the life of
// the link, with no cap on the set's size and no cap on the length of a member;
// `MAX_PEER_SUBSCRIPTIONS` guards `peer.subscribe` and `terminal.subscribe` and
// does not guard `unsubscribe`. Worse than the memory: the hub mints `sub_<n>`
// from a counter, so an id could be named *before it existed* and be believed
// when it did — which swallowed the owner's "I closed this pane".
//
// The set now only ever remembers ids this link actually holds, which the
// transport knows because they are the ids its own answers carried. An id from
// the wire that names nothing here is answered and forgotten.
//
// The second half is the rate. One Noise transport message is a byte stream of
// newline-delimited JSON, so one relay frame is as many requests as fit in
// 65,455 bytes — and a per-link token bucket in `handleRequest` is what stops
// that being as many dispatches.

import { describe, expect, it } from 'vitest'
import { Params } from '../../src/shared/methods'
import type { PeerSession } from '../../src/shared/peer'
import { createDispatcher } from '../../src/main/runtime/dispatcher'
import { MethodRegistry } from '../../src/main/runtime/methodRegistry'
import { encodeLine } from '../../src/main/runtime/peerFraming'
import { createPeerTransport, PEER_REQUEST_BURST, type PeerTransport } from '../../src/main/runtime/peerTransport'
import { createRuntimeContext } from '../../src/main/runtime/runtimeContext'
import { SubscriptionHub } from '../../src/main/runtime/subscriptionHub'
import { handshakenPair } from './peerRig'

type Rig = {
  /** Everything the owner's runtime wrote back to the teammate, decoded. */
  replies: () => unknown[]
  /** One relay frame carrying whatever lines the attacker wants in it. */
  sendRaw: (lines: readonly string[]) => void
  /** The subscription channel a `terminal.subscribe` opened, by pane. */
  pane: (terminalId: string) => { emit: (event: unknown) => void; close: () => void } | undefined
  dispatched: () => number
}

/**
 * The owner's peer transport, with an attacker on the far end that frames its
 * own bytes instead of using a transport.
 *
 * The Noise session and the framing are the real ones; only the relay is gone,
 * because what is under test is what the runtime does with the plaintext.
 */
function rig(): Rig {
  const [attackerSession, ownerSession]: [PeerSession, PeerSession] = handshakenPair()
  const hub = new SubscriptionHub()
  const panes = new Map<string, { emit: (event: unknown) => void; close: () => void }>()
  const registry = new MethodRegistry(createRuntimeContext({ version: 't', store: {} as never, subscriptions: hub }))
  let dispatched = 0

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

  const owner: PeerTransport = createPeerTransport({
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
    onFatal: () => {}
  })

  return {
    replies: () => replies,
    sendRaw: (lines) => {
      for (const message of encodeLine(attackerSession, `${lines.join('\n')}\n`)) owner.receive(message)
    },
    pane: (terminalId) => panes.get(terminalId),
    dispatched: () => dispatched
  }
}

/** Several turns, because a dispatch is a promise chain and the reply is written in its continuation. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()
}

/** Everything the owner pushed on one stream, in order. */
function eventsOn(replies: readonly unknown[], stream: string): unknown[] {
  return replies
    .filter((frame): frame is { stream: string; event: unknown } => (frame as { stream?: unknown }).stream === stream)
    .map((frame) => frame.event)
}

const LOST = { type: 'lost', reason: 'the owner closed this pane' }

describe('what a teammate can make the peer transport hold on to', () => {
  it('control: the owner closing a pane tells the watcher it was lost', async () => {
    const owner = rig()
    owner.sendRaw([JSON.stringify({ id: 'a', method: 'terminal.subscribe', params: { terminalId: 't1' } })])
    await settle()

    owner.pane('t1')?.close()

    expect(eventsOn(owner.replies(), 'sub_1')).toContainEqual(LOST)
  })

  it('ATTACK: an id named in `unsubscribe` before it exists is not believed when it does', async () => {
    const owner = rig()

    // The subscription hub mints `sub_<n>` from a counter, so the id the next
    // subscribe will be answered with is known in advance. Naming it now used
    // to file it under `releasing` without asking anything whether it was real,
    // and the transport then read the owner's own teardown as the peer's.
    owner.sendRaw([JSON.stringify({ id: 'x', method: 'unsubscribe', params: { subscription: 'sub_1' } })])
    await settle()

    owner.sendRaw([JSON.stringify({ id: 'a', method: 'terminal.subscribe', params: { terminalId: 't1' } })])
    await settle()
    owner.pane('t1')?.close()

    // The owner's "I closed this pane" goes out, which is the thing the
    // swallowed goodbye cost: a watcher left looking at a window that stopped
    // updating reads it as a teammate gone quiet.
    expect(eventsOn(owner.replies(), 'sub_1')).toContainEqual(LOST)
  })

  it('ATTACK: ids that name nothing are not accumulated, however many are sent', async () => {
    const owner = rig()

    // Hundreds of ids that name nothing at all, including every id the hub is
    // about to mint. Nothing is remembered from any of them, so the watch
    // opened afterwards behaves exactly as the control does.
    const junk: string[] = []
    for (let n = 0; n < 120; n += 1) {
      junk.push(JSON.stringify({ id: `j${n}`, method: 'unsubscribe', params: { subscription: `sub_${n}` } }))
    }
    owner.sendRaw(junk)
    await settle()

    owner.sendRaw([JSON.stringify({ id: 'a', method: 'terminal.subscribe', params: { terminalId: 't1' } })])
    await settle()
    owner.pane('t1')?.close()

    const opened = owner
      .replies()
      .find(
        (frame): frame is { id: string; ok: true; result: { subscription: string } } =>
          (frame as { id?: unknown }).id === 'a'
      )
    const stream = opened?.result.subscription ?? 'sub_1'
    expect(eventsOn(owner.replies(), stream)).toContainEqual(LOST)
  })

  it('ATTACK: an id of any length the frame decoder allows is answered and forgotten', async () => {
    const owner = rig()
    // `Params.unsubscribe` is `z.string().min(1)` with no maximum and the only
    // ceiling is MAX_PEER_FRAME_CHARS, which is 4 MiB per line — so the fix is
    // not a length check, it is that an id the link does not hold is never
    // written down at all.
    const huge = 'Z'.repeat(512 * 1024)
    owner.sendRaw([JSON.stringify({ id: 'x', method: 'unsubscribe', params: { subscription: huge } })])
    await settle()

    // Answered, and answered honestly: there was no such subscription.
    expect(owner.replies()).toContainEqual({ id: 'x', ok: true, result: { unsubscribed: false } })

    // And nothing was kept: the link behaves as a fresh one for the watch that
    // follows, which is the only thing retention could have changed.
    owner.sendRaw([JSON.stringify({ id: 'a', method: 'terminal.subscribe', params: { terminalId: 't1' } })])
    await settle()
    owner.pane('t1')?.close()
    expect(eventsOn(owner.replies(), 'sub_1')).toContainEqual(LOST)
  })

  it('ATTACK: one Noise transport message is no longer hundreds of dispatches', () => {
    const owner = rig()
    // A Noise transport message carries up to 65,455 bytes of plaintext, and
    // the plaintext is a byte stream of newline-delimited JSON. Nothing counted
    // requests, so the relay's 200-frames-a-second budget was not a bound on
    // how much work one second of wire could buy. The per-link bucket is.
    const lines: string[] = []
    let bytes = 0
    for (let n = 0; bytes < 60_000; n += 1) {
      const line = JSON.stringify({ id: `r${n}`, method: 'unsubscribe', params: { subscription: `s${n}` } })
      bytes += line.length + 1
      lines.push(line)
    }
    const before = owner.dispatched()
    owner.sendRaw(lines)

    expect(lines.length).toBeGreaterThan(800)
    // The burst, plus whatever the bucket earned back while the frame was being
    // decrypted — real milliseconds on a loaded machine, so this is asserted
    // with room rather than to the token. What matters is the shape: hundreds
    // of requests in one frame are no longer hundreds of dispatches.
    expect(owner.dispatched() - before).toBeLessThanOrEqual(PEER_REQUEST_BURST * 2)
    expect(owner.dispatched() - before).toBeLessThan(lines.length / 2)
    // Every one of the rest is answered rather than dropped.
    const refused = owner.replies().filter((frame) => (frame as { ok?: unknown }).ok === false)
    expect(refused).toHaveLength(lines.length - (owner.dispatched() - before))
  })
})
