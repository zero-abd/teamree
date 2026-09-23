// FIXED: `peerTransport.handleRequest` filed every `unsubscribe` id in `releasing` before dispatch, so
// ids naming nothing stayed for the life of the link (unbounded, any length), and since the hub mints
// `sub_<n>` from a counter an id named before it existed was believed when it did, swallowing the owner's
// "I closed this pane". The set now holds only ids this link's own answers carried. Second half: one
// Noise message is 65,455 bytes of newline-delimited JSON, so a per-link token bucket caps dispatches.

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

/** The owner's peer transport with an attacker framing its own bytes; real Noise and framing, no relay. */
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
    // Decrypted straight back into text, as the attacker's own line reader would see it.
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

    // The next subscribe's id is known in advance; naming it now used to make the owner's own
    // teardown read as the peer's.
    owner.sendRaw([JSON.stringify({ id: 'x', method: 'unsubscribe', params: { subscription: 'sub_1' } })])
    await settle()

    owner.sendRaw([JSON.stringify({ id: 'a', method: 'terminal.subscribe', params: { terminalId: 't1' } })])
    await settle()
    owner.pane('t1')?.close()

    // The owner's "I closed this pane" goes out; swallowed, a watcher reads a stopped window as silence.
    expect(eventsOn(owner.replies(), 'sub_1')).toContainEqual(LOST)
  })

  it('ATTACK: ids that name nothing are not accumulated, however many are sent', async () => {
    const owner = rig()

    // Hundreds of ids naming nothing, including every id the hub is about to mint.
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
    // `Params.unsubscribe` has no maximum short of MAX_PEER_FRAME_CHARS (4 MiB), so the fix is not a
    // length check: an id the link does not hold is never written down.
    const huge = 'Z'.repeat(512 * 1024)
    owner.sendRaw([JSON.stringify({ id: 'x', method: 'unsubscribe', params: { subscription: huge } })])
    await settle()

    // Answered, and answered honestly: there was no such subscription.
    expect(owner.replies()).toContainEqual({ id: 'x', ok: true, result: { unsubscribed: false } })

    // And nothing was kept: the watch that follows behaves as on a fresh link.
    owner.sendRaw([JSON.stringify({ id: 'a', method: 'terminal.subscribe', params: { terminalId: 't1' } })])
    await settle()
    owner.pane('t1')?.close()
    expect(eventsOn(owner.replies(), 'sub_1')).toContainEqual(LOST)
  })

  it('ATTACK: one Noise transport message is no longer hundreds of dispatches', () => {
    const owner = rig()
    // The relay's 200-frames-a-second budget bounded frames, not requests; the per-link bucket does.
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
    // The burst plus whatever the bucket earned back during decryption (real milliseconds on a
    // loaded machine), so asserted with room rather than to the token.
    expect(owner.dispatched() - before).toBeLessThanOrEqual(PEER_REQUEST_BURST * 2)
    expect(owner.dispatched() - before).toBeLessThan(lines.length / 2)
    // Every one of the rest is answered rather than dropped.
    const refused = owner.replies().filter((frame) => (frame as { ok?: unknown }).ok === false)
    expect(refused).toHaveLength(lines.length - (owner.dispatched() - before))
  })
})
