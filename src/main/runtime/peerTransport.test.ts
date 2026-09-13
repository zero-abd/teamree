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
import { MAX_REMOTE_WRITE_BYTES, Params } from '../../shared/methods'
import { createInitiatorSession, createResponderSession, generateStaticKeyPair } from '../../shared/peer'
import type { PeerSession } from '../../shared/peer'
import { ErrorCode } from '../../shared/protocol'
import { createDispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import {
  createPeerTransport,
  PEER_METHODS,
  STREAM_BUFFER_BYTES,
  STREAM_FLUSH_MS,
  type PeerTransport,
  type RemoteWriteRequest,
  type RemoteWriteVerdict,
  type TransportScheduler
} from './peerTransport'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'

/** A clock a test moves by hand, so pacing is asserted rather than waited out. */
function manualClock(): TransportScheduler & { advance: (ms: number) => void } {
  let now = 1_000
  const timers = new Map<number, { at: number; run: () => void }>()
  let sequence = 0
  return {
    now: () => now,
    setTimer: (run, delayMs) => {
      sequence += 1
      const id = sequence
      timers.set(id, { at: now + Math.max(0, delayMs), run })
      return () => {
        timers.delete(id)
      }
    },
    advance: (ms) => {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)
        const next = due[0]
        if (!next) break
        timers.delete(next[0])
        now = Math.max(now, next[1].at)
        next[1].run()
      }
      now = target
    }
  }
}

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
  /** Every stream event the teammate received, in order. */
  received: { stream: string; event: unknown }[]
  /** Every keystroke that reached a pane on the answering side, in order. */
  written: string[]
  /** The panes the answering side believes the teammate has open. */
  watched: () => readonly string[]
  /** Pushes one event into a pane the teammate subscribed to. */
  pane: (terminalId: string) => { emit: (event: unknown) => void; close: () => void } | undefined
  clock: ReturnType<typeof manualClock>
}

type RigOptions = {
  allowedMethods?: readonly Parameters<MethodRegistry['register']>[0][]
  /** The owner's verdict on a keystroke. Left out to prove nothing writes without one. */
  onRemoteWrite?: (write: RemoteWriteRequest) => RemoteWriteVerdict
  /** Run when the answering side first decrypts anything, as key confirmation is. */
  onConfirmed?: (transport: PeerTransport) => void
}

/**
 * Two transports wired mouth to ear.
 *
 * Delivery is synchronous, which is exactly what a WebSocket is not — but the
 * property under test is message boundaries, and a queue between them would
 * only prove the queue kept order.
 */
function rig(allowedMethods?: readonly Parameters<MethodRegistry['register']>[0][], options?: RigOptions): Rig {
  const [callerSession, answererSession] = handshakenPair()
  const hub = new SubscriptionHub()
  const clock = manualClock()
  const received: { stream: string; event: unknown }[] = []
  const written: string[] = []
  const panes = new Map<string, { emit: (event: unknown) => void; close: () => void }>()
  let watched: readonly string[] = []
  const registry = new MethodRegistry(createRuntimeContext({ version: 't', store: {} as never, subscriptions: hub }))

  // Stands in for the terminal service, and only for the part the transport can
  // see: an id, a stream, and a teardown. What is under test here is the wire,
  // not the pty — `relayProcess.test.ts` runs the real one.
  registry.register('terminal.subscribe', Params.terminalSubscribe, (params, call) => ({
    subscription: hub.subscribe(call.connectionId, (channel) => {
      panes.set(params.terminalId, channel)
      return () => panes.delete(params.terminalId)
    })
  }))
  registry.register('terminal.read', Params.terminalRead, () => ({ data: 'scrollback\r\n' }))
  registry.register('unsubscribe', Params.unsubscribe, (params, call) => ({
    unsubscribed: hub.unsubscribe(call.connectionId, params.subscription) as true
  }))

  registry.register('status.get', z.object({}), () => ({
    version: 't',
    endpoint: '',
    pid: 1,
    platform: 'linux' as NodeJS.Platform,
    startedAt: 0
  }))
  registry.register('peer.presence', z.object({}), () => ({ revision: 1, handle: 'them', projects: [] }))
  registry.register('worktree.remove', z.object({ worktreeId: z.string() }), () => ({ removed: true as const }))
  // Everything that actually reached a pane, so "refused" can be asserted as
  // nothing having happened rather than as an error message having come back.
  registry.register('terminal.write', Params.terminalWrite, (params) => {
    written.push(params.data)
    return { written: true as const }
  })

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
    onStreamEvent: (stream, event) => received.push({ stream, event }),
    onFatal: () => {}
  })
  answerer = createPeerTransport({
    session: answererSession,
    send: (message) => caller.receive(message),
    dispatch: createDispatcher(registry),
    subscriptions: hub,
    connectionId: 'peer_answerer',
    scheduler: clock,
    onWatchChange: (terminalIds) => {
      watched = terminalIds
    },
    ...(allowedMethods ? { allowedMethods } : {}),
    ...(options?.onRemoteWrite ? { onRemoteWrite: options.onRemoteWrite } : {}),
    ...(options?.onConfirmed ? { onConfirmed: () => options.onConfirmed?.(answerer) } : {}),
    onFatal: () => {}
  })

  return {
    caller,
    answerer,
    registry,
    hub,
    received,
    written,
    clock,
    watched: () => watched,
    pane: (terminalId) => panes.get(terminalId)
  }
}

/** Everything one stream carried, concatenated, as the watcher would see it. */
function outputOn(received: readonly { stream: string; event: unknown }[]): string {
  return received
    .filter((frame): frame is { stream: string; event: { type: 'data'; data: string } } => isData(frame.event))
    .map((frame) => frame.event.data)
    .join('')
}

function isData(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'data'
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

  it('lets a teammate read a pane and type into one, and reach nothing else', () => {
    // The list is asserted whole, so widening it stays a deliberate edit to one
    // line and never a side effect of registering a handler. C added the two
    // reads a watcher needs; D added `terminal.write` and nothing besides. A
    // teammate's window is not this pane's window and their keyboard is not its
    // power switch, so resize and close stay off it.
    expect([...PEER_METHODS]).toEqual([
      'peer.presence',
      'peer.subscribe',
      'terminal.read',
      'terminal.subscribe',
      'terminal.write',
      'unsubscribe'
    ])
    expect(PEER_METHODS).not.toContain('terminal.resize')
    expect(PEER_METHODS).not.toContain('terminal.close')
  })

  it('refuses a keystroke when nothing is there to attribute it to', async () => {
    // A transport wired without `onRemoteWrite` cannot say whose bytes these
    // are, so it does not carry them. "On the allow-list" and "allowed" are
    // deliberately two different things for the one method that runs code.
    const { caller, written } = rig(['terminal.write'])
    await expect(caller.call('terminal.write', { terminalId: 't_1', data: 'x' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
    expect(written).toEqual([])
  })

  it('asks the owner about every keystroke and writes only what they allow', async () => {
    const asked: string[] = []
    const { caller, written } = rig(['terminal.write'], {
      onRemoteWrite: (write) => {
        asked.push(write.data)
        return write.data === 'no'
          ? { ok: false, code: ErrorCode.Conflict, message: 'the owner has muted this pane' }
          : { ok: true }
      }
    })

    await expect(caller.call('terminal.write', { terminalId: 't_1', data: 'yes' })).resolves.toEqual({ written: true })
    await expect(caller.call('terminal.write', { terminalId: 't_1', data: 'no' })).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      // The owner's own words, carried to the person who typed. A refusal with
      // a generic message is a keystroke that vanished for no stated reason.
      message: 'the owner has muted this pane'
    })

    expect(asked).toEqual(['yes', 'no'])
    expect(written).toEqual(['yes'])
  })

  it('runs nothing from a message whose session was refused as it was being read', async () => {
    // Key confirmation happens on the first frame that decrypts and can itself
    // end the link: a session that authenticated a different key than the one
    // this side dialled is torn down inside `onConfirmed`, in the middle of the
    // message carrying it. Whatever else that message held arrived over a
    // session this machine has just refused, and a keystroke in it must not run
    // merely because the loop had already started.
    const { caller, written } = rig(['terminal.write'], {
      onRemoteWrite: () => ({ ok: true }),
      onConfirmed: (answerer) => answerer.close('the handshake authenticated a different key')
    })

    // Never answered, because the link it was sent over is gone. The sender
    // learns that from their own socket closing, which is what a real relay
    // does to the partner of a connection that went.
    void caller.call('terminal.write', { terminalId: 't_1', data: 'rm -rf ~' }).catch(() => {})
    await Promise.resolve()

    expect(written).toEqual([])
  })

  it('refuses a paste too large for the wire before anybody is asked about it', async () => {
    let asked = 0
    const { caller, written } = rig(['terminal.write'], {
      onRemoteWrite: () => {
        asked += 1
        return { ok: true }
      }
    })
    // One write is not allowed to spend a whole second of the relay's byte
    // budget for a link that is also carrying the pane's output back.
    const paste = 'x'.repeat(MAX_REMOTE_WRITE_BYTES + 1)
    await expect(caller.call('terminal.write', { terminalId: 't_1', data: paste })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams
    })
    expect(asked).toBe(0)
    expect(written).toEqual([])
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

describe('key confirmation', () => {
  it('does not fire on a handshake that merely completed', () => {
    // The distinction the whole gate rests on. A responder finishes `IK` having
    // only *written* message 2, so a replayer with a captured message 1 and no
    // private key reaches `established` carrying the real peer's static key.
    const [session] = handshakenPair()
    let confirmed = false
    createPeerTransport({
      session,
      send: () => {},
      dispatch: createDispatcher(
        new MethodRegistry(
          createRuntimeContext({ version: 't', store: {} as never, subscriptions: new SubscriptionHub() })
        )
      ),
      subscriptions: new SubscriptionHub(),
      connectionId: 'peer_x',
      onConfirmed: () => {
        confirmed = true
      },
      onFatal: () => {}
    })
    expect(confirmed).toBe(false)
  })

  it('fires on the first transport message that authenticates, and only once', () => {
    const [alice, bob] = handshakenPair()
    let confirmations = 0
    const receiver = createPeerTransport({
      session: bob,
      send: () => {},
      dispatch: createDispatcher(
        new MethodRegistry(
          createRuntimeContext({ version: 't', store: {} as never, subscriptions: new SubscriptionHub() })
        )
      ),
      subscriptions: new SubscriptionHub(),
      connectionId: 'peer_y',
      onConfirmed: () => {
        confirmations += 1
      },
      onFatal: () => {}
    })

    // An empty keepalive line: nothing to act on, and proof that whoever sent
    // it holds keys a recording cannot supply.
    receiver.receive(alice.encrypt(new TextEncoder().encode('\n')))
    expect(confirmations).toBe(1)
    receiver.receive(alice.encrypt(new TextEncoder().encode('\n')))
    expect(confirmations).toBe(1)
  })

  it('never fires for a sender who cannot produce a valid transport message', () => {
    const [session] = handshakenPair()
    let confirmed = false
    let fatal = false
    const transport = createPeerTransport({
      session,
      send: () => {},
      dispatch: createDispatcher(
        new MethodRegistry(
          createRuntimeContext({ version: 't', store: {} as never, subscriptions: new SubscriptionHub() })
        )
      ),
      subscriptions: new SubscriptionHub(),
      connectionId: 'peer_z',
      onConfirmed: () => {
        confirmed = true
      },
      onFatal: () => {
        fatal = true
      }
    })

    // What a replayer has: the ability to open a connection, and nothing to say.
    transport.receive(new Uint8Array(48))
    expect(confirmed).toBe(false)
    expect(fatal).toBe(true)
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

describe('a pane against the relay’s budget', () => {
  it('merges a burst into one frame instead of spending the relay’s frame budget', async () => {
    const { caller, received, pane, clock } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    const channel = pane('t1')

    // The first chunk after a pause goes straight out: watching is not
    // uniformly a flush behind for a pane that only speaks occasionally.
    channel?.emit({ type: 'data', data: 'first\r\n' })
    expect(received).toHaveLength(1)

    // The rest of the burst arrives inside one flush window and leaves as one
    // frame, which is lossless: two chunks of a byte stream concatenated are
    // the same byte stream.
    for (let chunk = 0; chunk < 50; chunk += 1) channel?.emit({ type: 'data', data: `line ${chunk}\r\n` })
    expect(received).toHaveLength(1)

    clock.advance(STREAM_FLUSH_MS)
    expect(received).toHaveLength(2)
    expect(outputOn(received)).toContain('line 0\r\nline 1\r\n')
    expect(outputOn(received)).toContain('line 49\r\n')
  })

  it('tells the watcher how much it threw away rather than dropping output silently', async () => {
    const { caller, received, pane, clock } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    const channel = pane('t1')

    channel?.emit({ type: 'data', data: 'x' })
    // Far past what may wait for the wire. The tail is what a reader wants, so
    // the head goes — and the count of what went is sent with it.
    const overflow = 'y'.repeat(STREAM_BUFFER_BYTES * 2)
    channel?.emit({ type: 'data', data: overflow })
    clock.advance(STREAM_FLUSH_MS)

    const elided = received.find((frame) => (frame.event as { type?: string }).type === 'elided')?.event as
      | { type: string; bytes: number }
      | undefined
    expect(elided?.type).toBe('elided')
    expect(elided?.bytes ?? 0).toBeGreaterThanOrEqual(STREAM_BUFFER_BYTES)
    // What survived is the end of the burst, not the beginning of it.
    expect(outputOn(received).endsWith('y')).toBe(true)
  })

  it('never throws away an exit, because a pane that finished is a fact and not a volume', async () => {
    const { caller, received, pane, clock } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    const channel = pane('t1')

    channel?.emit({ type: 'data', data: 'z'.repeat(STREAM_BUFFER_BYTES * 3) })
    channel?.emit({ type: 'exit', exitCode: 0 })
    // Generous: the byte budget is spent over several flushes, and the point is
    // that the exit is still there at the end of them rather than how fast.
    for (let tick = 0; tick < 200; tick += 1) clock.advance(STREAM_FLUSH_MS)

    expect(received.map((frame) => frame.event)).toContainEqual({ type: 'exit', exitCode: 0 })
  })

  it('keeps an exit behind the output it follows, so a pane never finishes before it speaks', async () => {
    const { caller, received, pane, clock } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    const channel = pane('t1')

    channel?.emit({ type: 'data', data: 'a' })
    channel?.emit({ type: 'data', data: 'b' })
    channel?.emit({ type: 'exit', exitCode: 0 })
    clock.advance(STREAM_FLUSH_MS)

    const types = received.map((frame) => (frame.event as { type: string }).type)
    expect(types.indexOf('exit')).toBeGreaterThan(types.lastIndexOf('data'))
  })
})

describe('what the owner is told about who is reading', () => {
  it('names the pane a teammate opened, and forgets it when they close it', async () => {
    const { caller, watched } = rig()
    const { subscription } = await caller.call('terminal.subscribe', { terminalId: 't1' })
    expect(watched()).toEqual(['t1'])

    await caller.call('unsubscribe', { subscription })
    expect(watched()).toEqual([])
  })

  it('forgets a pane whose stream the owner ended, and says so rather than going quiet', async () => {
    const { caller, received, pane, watched } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    expect(watched()).toEqual(['t1'])

    // What the owner closing their own pane looks like from here: the producer
    // ends the stream, and nothing else would ever tell the reader.
    pane('t1')?.close()

    expect(watched()).toEqual([])
    expect(received.map((frame) => frame.event)).toContainEqual({
      type: 'lost',
      reason: 'the owner closed this pane'
    })
  })

  it('reports one pane per teammate however many streams they hold on it', async () => {
    const { caller, watched } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    await caller.call('terminal.subscribe', { terminalId: 't1' })

    expect(watched()).toEqual(['t1'])
  })

  it('says nobody is reading a pane a teammate asked for and was refused', async () => {
    const { caller, watched } = rig(['peer.presence', 'unsubscribe'])
    await expect(caller.call('terminal.subscribe', { terminalId: 't1' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })

    expect(watched()).toEqual([])
  })
})
