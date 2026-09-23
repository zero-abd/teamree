// Two runtimes, two data directories, two identities, and a relay between
// them. Every test here drives both sides at once, because a handshake asserted
// from one end is a handshake against a fixture.

import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEAMMATE_CACHE_FILE, TeammateCacheStore, type TeammateCache } from '../../store/teammateCache'
import { loadIdentity } from '../identity'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  remoteRunner,
  makeProjectDir,
  project,
  presenceOf,
  statusOf,
  terminal,
  worktree,
  type FakeRelay,
  type ManualScheduler,
  type PeerRuntime
} from './peerTestSupport'
import { isNewerPresence, linkIdFor, parsePeerPresence } from './peerService'
import { normaliseRemote, projectKeyFor } from './projectKey'
import {
  createPeerLink,
  BACKOFF_CEILING_MS,
  HANDSHAKE_STALLED_DETAIL,
  HANDSHAKE_TIMEOUT_MS,
  HEALTHY_SESSION_MS,
  KEEPALIVE_MS,
  LINK_QUIET_AFTER_MS,
  MAX_UNROUTED_EVENTS,
  MAX_UNROUTED_STREAMS,
  RECONNECT_FLOOR_MS,
  SILENCE_TIMEOUT_MS,
  SILENT_PEER_DETAIL,
  STOPPED_RETRY_MS,
  UNAUTHENTICATED_DETAIL,
  WAITING_DETAIL,
  WAITING_TOO_LONG_DETAIL,
  WOKE_DETAIL,
  type PeerLink
} from './peerLink'
import { RelayCloseCode } from './relayConnection'
import type { RelayDialer } from './relaySocket'
import type { WakeWatch } from './wakeWatch'
import { Params } from '../../../shared/methods'
import { createDispatcher } from '../../runtime/dispatcher'
import { CLOCK_JUMP_TOLERANCE_MS } from '../../runtime/elapsed'
import { MethodRegistry } from '../../runtime/methodRegistry'
import { createRuntimeContext } from '../../runtime/runtimeContext'
import { SubscriptionHub, type SubscriptionChannel } from '../../runtime/subscriptionHub'
import { MAX_PEER_SUBSCRIPTIONS, PEER_CALL_TIMEOUT_MS, STREAM_FLUSH_MS } from '../../runtime/peerTransport'
import { MAX_CACHED_PANES, MAX_CACHED_TEXT, MAX_CACHED_WORKTREES } from '../../store/teammateCache'
import { loadStaticPrivateKey } from '../identity'
import { epochAt, rendezvousId, rendezvousToken, sharedSecret } from './rendezvous'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
/** Where `createManualScheduler` starts. A cache shares that clock or it ages wrongly. */
const CLOCK_START = 1_700_000_000_000
const ORIGIN = 'git@github.com:team/repo.git'

type Pair = {
  relay: FakeRelay
  scheduler: ManualScheduler
  alice: PeerRuntime
  bob: PeerRuntime
  aliceKey: string
  bobKey: string
  /** Alice's checkout, so a restart can be built against the same repository. */
  aliceProject: string
}

/**
 * Two installations that have each other in their rosters, on one relay. The
 * rosters are real files: "is this key on the roster" is the whole trust model.
 */
async function pairOfRuntimes(
  options: {
    relay?: FakeRelay
    aliceSeesBob?: boolean
    aliceCache?: TeammateCache
    /** Wraps Bob's socket, for a test about what one end does and the other does not. */
    bobDial?: (dial: RelayDialer) => RelayDialer
    /** Stands in for the power monitor on Alice's machine only. */
    aliceWatchWake?: WakeWatch
  } = {}
): Promise<Pair> {
  const relay = options.relay ?? createFakeRelay()
  const scheduler = createManualScheduler()

  const aliceData = await makeProjectDir([])
  const bobData = await makeProjectDir([])
  const aliceKey = (await loadIdentity(aliceData)).publicKey
  const bobKey = (await loadIdentity(bobData)).publicKey

  const aliceRoster =
    options.aliceSeesBob === false
      ? [{ handle: 'alice', publicKey: aliceKey }]
      : [
          { handle: 'alice', publicKey: aliceKey },
          { handle: 'bob', publicKey: bobKey }
        ]
  const aliceProject = await makeProjectDir(aliceRoster)
  const bobProject = await makeProjectDir([
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'bob', publicKey: bobKey }
  ])

  const shared = {
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: fixedRemoteRunner(ORIGIN)
  }

  const alice = await createPeerRuntime({
    ...shared,
    dataDir: aliceData,
    ...(options.aliceCache ? { cache: options.aliceCache } : {}),
    ...(options.aliceWatchWake ? { watchWake: options.aliceWatchWake } : {}),
    workspace: {
      projects: [project('p_alice', aliceProject)],
      worktrees: [worktree('wt_a1', 'p_alice', 'search ranking', 'feat/ranking')],
      terminals: [terminal('t_a1', 'wt_a1', { agent: 'claude', busy: true, lastOutputAt: scheduler.now() })]
    }
  })
  const bob = await createPeerRuntime({
    ...shared,
    ...(options.bobDial ? { dial: options.bobDial(relay.dial) } : {}),
    dataDir: bobData,
    workspace: {
      projects: [project('p_bob', bobProject)],
      worktrees: [worktree('wt_b1', 'p_bob', 'flaky test', 'fix/flake')],
      terminals: [terminal('t_b1', 'wt_b1', { agent: 'codex', lastOutputAt: scheduler.now() - 90_000 })]
    }
  })

  return { relay, scheduler, alice, bob, aliceKey, bobKey, aliceProject }
}

/** Alice's app, closed and opened again: same identity, repository and workspace, nothing carried over. */
async function reopenAlice(pair: Pair, cache?: TeammateCache): Promise<PeerRuntime> {
  return createPeerRuntime({
    dial: pair.relay.dial,
    scheduler: pair.scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: fixedRemoteRunner(ORIGIN),
    dataDir: pair.alice.dataDir,
    workspace: pair.alice.workspace,
    ...(cache ? { cache } : {})
  })
}

async function freshCachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'teamree-teammates-')), TEAMMATE_CACHE_FILE)
}

/** Polls a real filesystem fact. The clock everything else here uses is a fake one. */
async function untilOnDisk(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (
      await stat(filePath).then(
        () => true,
        () => false
      )
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${filePath} never appeared`)
}

function bobsRows(runtime: PeerRuntime): { name: string; live: boolean; heardAt: number }[] {
  return presenceOf(runtime.service, 'p_alice').worktrees.map((row) => ({
    name: row.name,
    live: row.live,
    heardAt: row.heardAt
  }))
}

/** Brings both sides up and lets the handshake and the first snapshot settle. */
async function connect(pair: Pair): Promise<void> {
  await pair.alice.service.start()
  await pair.bob.service.start()
  await pair.scheduler.advance(0)
}

function linkTo(runtime: PeerRuntime, projectId: string, publicKey: string) {
  return statusOf(runtime.service, projectId).links.find((link) => link.publicKey === publicKey)
}

/**
 * A socket that sends its first content frame and then nothing: the far end
 * completes an `IK` and reaches the unconfirmed window, which is what a
 * replayer holding a recording and no private key can manage.
 */
function muteAfterHandshake(dial: RelayDialer): RelayDialer {
  return (url, handlers) => {
    const socket = dial(url, handlers)
    let sent = 0
    return {
      sendText: (text) => socket.sendText(text),
      sendBinary: (payload) => {
        sent += 1
        if (sent === 1) socket.sendBinary(payload)
      },
      close: (code, reason) => socket.close(code, reason)
    }
  }
}

/**
 * A relay that changes one byte of one frame: the single observable symptom of
 * an untrusted relay. Flipped in a frame this side *sends*.
 */
function relayThatChangesAByte(): { wrap: (dial: RelayDialer) => RelayDialer; arm: () => void } {
  let armed = false
  return {
    arm: () => {
      armed = true
    },
    wrap: (dial) => (url, handlers) => {
      const socket = dial(url, handlers)
      return {
        sendText: (text) => socket.sendText(text),
        sendBinary: (payload) => {
          if (!armed) {
            socket.sendBinary(payload)
            return
          }
          armed = false
          const changed = Uint8Array.from(payload)
          const last = changed.length - 1
          if (last >= 0) changed[last] = (changed[last] ?? 0) ^ 0x01
          socket.sendBinary(changed)
        },
        close: (code, reason) => socket.close(code, reason)
      }
    }
  }
}

/**
 * A machine that keeps its socket and stops using it: a closed lid. No close
 * frame is ever written, so the relay and the far end see an open connection.
 * Every other failure here ends a socket, which is the case that already worked.
 */
function sleepingLid(): { wrap: (dial: RelayDialer) => RelayDialer; sleep: () => void } {
  let asleep = false
  return {
    sleep: () => {
      asleep = true
    },
    wrap: (dial) => (url, handlers) => {
      const socket = dial(url, {
        onOpen: () => {
          if (!asleep) handlers.onOpen()
        },
        onText: (text) => {
          if (!asleep) handlers.onText(text)
        },
        onBinary: (payload) => {
          if (!asleep) handlers.onBinary(payload)
        },
        onClosed: (code, reason) => {
          if (!asleep) handlers.onClosed(code, reason)
        }
      })
      return {
        sendText: (text) => {
          if (!asleep) socket.sendText(text)
        },
        sendBinary: (payload) => {
          if (!asleep) socket.sendBinary(payload)
        },
        close: (code, reason) => {
          if (!asleep) socket.close(code, reason)
        }
      }
    }
  }
}

/**
 * A socket that holds everything back and then lets it all through, in order:
 * a suspended laptop's connection loses nothing and delivers late, the only
 * silence a link can come back from (`sleepingLid` holes the Noise transcript).
 */
function stalledLid(): { wrap: (dial: RelayDialer) => RelayDialer; stall: () => void; resume: () => void } {
  let stalled = false
  const held: (() => void)[] = []
  const run = (effect: () => void): void => {
    if (stalled) held.push(effect)
    else effect()
  }
  return {
    stall: () => {
      stalled = true
    },
    resume: () => {
      stalled = false
      for (const effect of held.splice(0, held.length)) effect()
    },
    wrap: (dial) => (url, handlers) => {
      const socket = dial(url, {
        onOpen: () => run(() => handlers.onOpen()),
        onText: (text) => run(() => handlers.onText(text)),
        onBinary: (payload) => run(() => handlers.onBinary(payload)),
        onClosed: (code, reason) => run(() => handlers.onClosed(code, reason))
      })
      return {
        sendText: (text) => run(() => socket.sendText(text)),
        sendBinary: (payload) => run(() => socket.sendBinary(payload)),
        close: (code, reason) => run(() => socket.close(code, reason))
      }
    }
  }
}

/** A subscription channel that keeps whatever it was given, in order. */
function recorder(): { channel: SubscriptionChannel; events: unknown[] } {
  const events: unknown[] = []
  return {
    events,
    channel: {
      emit: (event) => events.push(event),
      close: () => {}
    }
  }
}

/** Bob’s pane as Alice’s side names it, which is what a watcher is handed. */
function bobsPaneId(runtime: PeerRuntime): string {
  const pane = presenceOf(runtime.service, 'p_alice').worktrees[0]?.panes[0]
  if (!pane) throw new Error('Bob’s pane is not in Alice’s presence')
  return pane.id
}

/**
 * One link with nothing behind it: a teammate who asks for things, including
 * things a runtime would never ask.
 */
async function rawLink(options: {
  relay: FakeRelay
  scheduler: ManualScheduler
  dataDir: string
  remotePublicKey: string
  handle: string
}): Promise<{ link: PeerLink; phase: () => string }> {
  const hub = new SubscriptionHub()
  const registry = new MethodRegistry(createRuntimeContext({ version: 'test', store: {} as never, subscriptions: hub }))
  // Answered because the teammate's own link subscribes the moment it confirms
  // and would tear the session down if nobody were home.
  registry.register('peer.presence', Params.peerPresence, () => ({ revision: 1, handle: options.handle, projects: [] }))
  registry.register('peer.subscribe', Params.peerSubscribe, (_params, call) => ({
    subscription: hub.subscribe(call.connectionId, () => () => {})
  }))

  let phase = 'connecting'
  const link = createPeerLink({
    remotePublicKey: options.remotePublicKey,
    handle: options.handle,
    projectKey: projectKeyFor(normaliseRemote(ORIGIN)!),
    staticPrivateKey: await loadStaticPrivateKey(options.dataDir),
    relayUrl: RELAY_URL,
    connectionId: `${options.handle}_link`,
    dial: options.relay.dial,
    dispatch: createDispatcher(registry),
    subscriptions: hub,
    scheduler: options.scheduler,
    onStatusChange: (status) => {
      phase = status.phase
    },
    onPresence: () => {}
  })
  link.start()
  await options.scheduler.advance(0)
  return { link, phase: () => phase }
}

/** Makes a runtime answer every peer with `snapshot`, whatever it actually holds. */
function answerPresenceWith(runtime: PeerRuntime, snapshot: unknown): void {
  ;(runtime.service as unknown as { peerPresence: (connectionId: string) => unknown }).peerPresence = () => snapshot
}

describe('two peers over a relay', () => {
  it('completes the Noise handshake and shows each other’s worktrees', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    expect(linkTo(pair.bob, 'p_bob', pair.aliceKey)?.phase).toBe('connected')

    const seenByAlice = presenceOf(pair.alice.service, 'p_alice')
    expect(seenByAlice.worktrees.map((entry) => [entry.handle, entry.name, entry.branch])).toEqual([
      ['bob', 'flaky test', 'fix/flake']
    ])

    const seenByBob = presenceOf(pair.bob.service, 'p_bob')
    expect(seenByBob.worktrees.map((entry) => [entry.handle, entry.name])).toEqual([['alice', 'search ranking']])
  })

  it('carries each pane’s agent and activity, and never a byte of its output', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    const [bobsWorktree] = presenceOf(pair.alice.service, 'p_alice').worktrees
    const [pane] = bobsWorktree?.panes ?? []
    expect(pane?.agent).toBe('codex')
    expect(pane?.running).toBe(true)
    expect(pane?.busy).toBe(false)
    // Silence crosses as a duration, because two machines do not agree about
    // what time it is and an instant from a fast clock renders as the future.
    expect(pane?.quietForMs).toBeGreaterThanOrEqual(90_000)
    // Nothing that could carry a line of terminal output is on the wire; the
    // dimensions are metadata so a watcher can letterbox.
    expect(Object.keys(pane ?? {}).sort()).toEqual(
      ['agent', 'busy', 'cols', 'id', 'quietForMs', 'rows', 'running', 'shell', 'title'].sort()
    )
  })

  it('namespaces a teammate’s ids, so two installations cannot collide on one', async () => {
    const pair = await pairOfRuntimes()
    // Both sides happen to have generated the same local id, which is ordinary:
    // ids are per installation and nothing makes them unique across machines.
    pair.bob.workspace.worktrees[0]!.id = 'wt_a1'
    await connect(pair)

    const [seen] = presenceOf(pair.alice.service, 'p_alice').worktrees
    expect(seen?.id).not.toBe('wt_a1')
    expect(seen?.id.startsWith('peer:')).toBe(true)
  })

  it('refuses a peer whose static key is not in this project’s roster', async () => {
    // Alice's roster does not have Bob, so Alice opens no link to him at all and
    // Bob's dial finds nobody: not being a member is not being reachable.
    const pair = await pairOfRuntimes({ aliceSeesBob: false })
    await connect(pair)

    expect(statusOf(pair.alice.service, 'p_alice').links).toEqual([])
    expect(linkTo(pair.bob, 'p_bob', pair.aliceKey)?.phase).toBe('waiting')
    expect(presenceOf(pair.bob.service, 'p_bob').worktrees).toEqual([])
  })

  it('tells a teammate nothing about a project they are not a member of', async () => {
    const pair = await pairOfRuntimes()
    // A second repository Alice is in and Bob is not.
    const privateProject = await makeProjectDir([{ handle: 'alice', publicKey: pair.aliceKey }])
    pair.alice.workspace.projects.push(project('p_private', privateProject))
    pair.alice.workspace.worktrees.push(worktree('wt_secret', 'p_private', 'acquisition', 'feat/acq'))
    await connect(pair)

    // Refused twice over: the session is for one project, and the roster is
    // checked again where the data is chosen.
    const shared = projectKeyFor(normaliseRemote(ORIGIN)!)
    const snapshot = pair.alice.service.peerPresence(linkIdFor(pair.bobKey, shared))
    expect(snapshot.projects).toHaveLength(1)
    expect(JSON.stringify(snapshot)).not.toContain('acquisition')

    // And there is no session the private one could have arrived over.
    const secret = projectKeyFor('github.com/team/secret')
    expect(() => pair.alice.service.peerPresence(linkIdFor(pair.bobKey, secret))).toThrow()
  })

  it('gives one teammate one session per shared repository, not one in total', async () => {
    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const aliceData = await makeProjectDir([])
    const bobData = await makeProjectDir([])
    const aliceKey = (await loadIdentity(aliceData)).publicKey
    const bobKey = (await loadIdentity(bobData)).publicKey
    const roster = [
      { handle: 'alice', publicKey: aliceKey },
      { handle: 'bob', publicKey: bobKey }
    ]
    // Two repositories the two of them both push to.
    const first = await makeProjectDir(roster)
    const second = await makeProjectDir(roster)

    const alice = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: aliceData,
      runner: remoteRunner({ [first]: ORIGIN, [second]: 'git@github.com:team/other.git' }),
      workspace: { projects: [project('p_one', first), project('p_two', second)], worktrees: [], terminals: [] }
    })
    await alice.service.start()
    await scheduler.advance(0)

    // Two links, one per repository, each parked on a rendezvous of its own.
    expect(linkTo(alice, 'p_one', bobKey)?.phase).toBe('waiting')
    expect(linkTo(alice, 'p_two', bobKey)?.phase).toBe('waiting')
    // Two different rendezvous for one pair of people, so the relay cannot tell
    // that the two conversations are the same two people.
    expect(new Set(relay.greetings()).size).toBe(2)
  })

  it('shares one link between two local clones of one repository', async () => {
    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const aliceData = await makeProjectDir([])
    const bobData = await makeProjectDir([])
    const aliceKey = (await loadIdentity(aliceData)).publicKey
    const bobKey = (await loadIdentity(bobData)).publicKey
    const roster = [
      { handle: 'alice', publicKey: aliceKey },
      { handle: 'bob', publicKey: bobKey }
    ]
    const cloneA = await makeProjectDir(roster)
    const cloneB = await makeProjectDir(roster)

    const alice = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: aliceData,
      // The same repository, checked out twice and added twice.
      runner: remoteRunner({ [cloneA]: ORIGIN, [cloneB]: ORIGIN }),
      workspace: { projects: [project('p_a', cloneA), project('p_b', cloneB)], worktrees: [], terminals: [] }
    })
    await alice.service.start()
    await scheduler.advance(0)

    // One rendezvous, derived from the repository and not the local project row:
    // two links would present the same token and displace each other forever.
    expect(new Set(relay.greetings()).size).toBe(1)
    // Both projects still report it, because both of them really are it.
    expect(linkTo(alice, 'p_a', bobKey)?.phase).toBe('waiting')
    expect(linkTo(alice, 'p_b', bobKey)?.phase).toBe('waiting')
  })

  it('refuses a project key claimed by somebody not on that project’s roster', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    // Bob is dropped from Alice's roster after the fact, exactly the way a key
    // deleted from the repository reaches her at the next fetch.
    const stripped = await makeProjectDir([{ handle: 'alice', publicKey: pair.aliceKey }])
    pair.alice.workspace.projects[0] = project('p_alice', stripped)
    await pair.alice.service.reconcile()

    expect(presenceOf(pair.alice.service, 'p_alice').worktrees).toEqual([])
    expect(statusOf(pair.alice.service, 'p_alice').links).toEqual([])
  })
})

describe('presence stays live', () => {
  it('sends a new snapshot when a worktree appears, without anyone asking', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(presenceOf(pair.alice.service, 'p_alice').worktrees).toHaveLength(1)

    pair.bob.workspace.worktrees.push(worktree('wt_b2', 'p_bob', 'second thing', 'feat/second'))
    pair.bob.changed()
    await pair.scheduler.advance(1_000)

    expect(presenceOf(pair.alice.service, 'p_alice').worktrees.map((w) => w.name)).toEqual([
      'flaky test',
      'second thing'
    ])
  })

  it('coalesces a burst of changes into one snapshot', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const before = pair.alice.changes()

    for (let index = 0; index < 8; index += 1) pair.bob.changed()
    await pair.scheduler.advance(1_000)

    // One snapshot for the burst, not eight.
    expect(pair.alice.changes() - before).toBe(1)
  })

  it('drops a snapshot that arrives behind one already applied', () => {
    const held = { revision: 4, handle: 'bob', projects: [] }
    // A reply overtaken in flight: applying it would put the sidebar back into
    // a past its sender has already left.
    expect(isNewerPresence(held, { revision: 3, handle: 'bob', projects: [] })).toBe(false)
    expect(isNewerPresence(held, { revision: 4, handle: 'bob', projects: [] })).toBe(false)
    expect(isNewerPresence(held, { revision: 5, handle: 'bob', projects: [] })).toBe(true)
    expect(isNewerPresence(undefined, { revision: 1, handle: 'bob', projects: [] })).toBe(true)
  })
})

describe('the failure paths', () => {
  it('reports a relay it cannot reach as unreachable, not as a quiet teammate', async () => {
    const relay = createFakeRelay()
    relay.pause()
    const pair = await pairOfRuntimes({ relay })
    await connect(pair)

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.phase).toBe('unreachable')
    expect(link?.detail).toBeTruthy()
  })

  it('comes back by itself once the relay is up again', async () => {
    const relay = createFakeRelay()
    relay.pause()
    const pair = await pairOfRuntimes({ relay })
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('unreachable')

    relay.resume()
    await pair.scheduler.advance(30_000)

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    expect(presenceOf(pair.alice.service, 'p_alice').worktrees).toHaveLength(1)
  })

  it('rebuilds the session when the relay restarts under it', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    // A relay going away closes every session with 1001, which is "reconnect
    // shortly" and not "your client is broken".
    pair.relay.closeAll(RelayCloseCode.GoingAway, 'going away')
    await pair.scheduler.advance(5_000)

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    expect(linkTo(pair.bob, 'p_bob', pair.aliceKey)?.phase).toBe('connected')
  })

  it('says a teammate who vanished is not connected, and stops calling what they showed live', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(presenceOf(pair.alice.service, 'p_alice').worktrees).toHaveLength(1)

    pair.bob.service.stop()
    await pair.scheduler.advance(100)

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.phase).toBe('waiting')
    // The rows stay — a worktree row vanishing reads as a worktree deleted —
    // and not one of them is live any more.
    expect(bobsRows(pair.alice).map((row) => [row.name, row.live])).toEqual([['flaky test', false]])
  })

  it('pairs on the first try after one side reconnects over its own half-open session', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    // Bob's machine suspends: his old socket reads as open, he dials again, the
    // relay ends the session and both old peers get 4002, which is a back-off,
    // never an immediate retry, or the two displace each other for ever.
    const bobsSecondRuntime = pair.bob
    bobsSecondRuntime.service.stop()
    await bobsSecondRuntime.service.start()
    await pair.scheduler.advance(120_000)

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    expect(linkTo(pair.bob, 'p_bob', pair.aliceKey)?.phase).toBe('connected')
  })

  it('does not call a link connected until something from the far end decrypts', async () => {
    const pair = await pairOfRuntimes()
    await pair.alice.service.start()
    await pair.bob.service.start()

    // The relay pairs them and the handshake runs, but every frame is held: the
    // state a replayer leaves a responder in.
    pair.relay.holdContent()
    await pair.scheduler.advance(0)

    const stuck = linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase
    expect(stuck).not.toBe('connected')

    // Release them and the first authenticated frame confirms the keys.
    pair.relay.releaseContent()
    await pair.scheduler.advance(0)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })

  it('gives up on a peer that completed a handshake it cannot follow through', async () => {
    // The shape a replayer leaves a responder in: message 1 is real, the
    // handshake completes, and nothing is ever said again.
    const pair = await pairOfRuntimes({ bobDial: muteAfterHandshake })
    // Bob parks first, so he is the initiator and Alice is the responder: the
    // side that reaches `established` on a message it only wrote.
    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    await pair.alice.service.start()
    await pair.scheduler.advance(0)

    // The handshake really did complete on Alice's side, which is what makes
    // this the deadline's window and not merely a peer that never arrived.
    expect(pair.relay.connections()).toBe(2)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).not.toBe('connected')
    const dialled = pair.relay.greetings().length

    // A session nobody can speak on must not hold its slot for ever, and this
    // side's own keepalive would otherwise defeat the relay's idle deadline.
    await pair.scheduler.advance(HANDSHAKE_TIMEOUT_MS + 5_000)
    // Dialled again: the wedged socket was let go of.
    expect(pair.relay.greetings().length).toBeGreaterThan(dialled)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).not.toBe('connected')
  })

  it('re-registers under the next hour’s token when the epoch turns while it waits', async () => {
    const relay = createFakeRelay()
    const pair = await pairOfRuntimes({ relay })
    // Only Alice dials, so she parks rather than pairing.
    await pair.alice.service.start()
    await pair.scheduler.advance(0)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('waiting')

    const firstEpoch = epochAt(pair.scheduler.now())
    const first = relay.greetings().at(-1)

    await pair.scheduler.advance(3_600_000)
    const second = relay.greetings().at(-1)

    expect(second).not.toBe(first)
    expect(epochAt(pair.scheduler.now())).toBe(firstEpoch + 1)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('waiting')
  })

  it('names the two things to check once nobody has arrived for two hours', async () => {
    // A clock across the hourly boundary and a teammate on a different relay
    // both look exactly like this, for ever; the client says only how long it
    // has waited and what that narrows to.
    const relay = createFakeRelay()
    const pair = await pairOfRuntimes({ relay })
    await pair.alice.service.start()
    await pair.scheduler.advance(0)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBe(WAITING_DETAIL)

    await pair.scheduler.advance(3_600_000)
    // One rotation proves nothing: a link started at any point in an hour can
    // cross its first boundary a second later.
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBe(WAITING_DETAIL)

    await pair.scheduler.advance(3_600_000)
    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.phase).toBe('waiting')
    expect(link?.detail).toBe(WAITING_TOO_LONG_DETAIL)
    expect(link?.detail).toContain('.teamree/relay')
    expect(link?.detail).toContain('time')
  })

  it('goes back to saying nothing extra once somebody answers the rendezvous', async () => {
    const pair = await pairOfRuntimes()
    await pair.alice.service.start()
    await pair.scheduler.advance(0)
    await pair.scheduler.advance(7_200_000)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBe(WAITING_TOO_LONG_DETAIL)

    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })

  it('never lets one hello reach the relay twice for the same pair of keys', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const [aliceToken, bobToken] = pair.relay.greetings()
    // Both derived it independently from the same Diffie-Hellman, so they meet.
    expect(aliceToken).toBe(bobToken)
    expect(aliceToken).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('a teammate who is not there', () => {
  it('keeps a teammate’s worktrees on screen when their laptop closes, and says how old they are', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const heardAt = pair.scheduler.now()

    pair.bob.service.stop()
    await pair.scheduler.advance(600_000)

    const [row] = bobsRows(pair.alice)
    expect(row?.name).toBe('flaky test')
    expect(row?.live).toBe(false)
    // The age is this machine's own arithmetic on its own stamp. Nothing about
    // it came from the machine that is no longer answering.
    expect(pair.scheduler.now() - (row?.heardAt ?? 0)).toBe(600_000)
    expect(heardAt).toBeLessThanOrEqual(row?.heardAt ?? 0)
  })

  it('tells a teammate never heard from apart from one whose machine is away', async () => {
    const relay = createFakeRelay()
    relay.pause()
    const pair = await pairOfRuntimes({ relay })
    await pair.alice.service.start()
    await pair.scheduler.advance(0)

    const seen = presenceOf(pair.alice.service, 'p_alice')
    // No rows at all, and a named teammate with nothing behind them — never the
    // same shape as somebody whose rows are simply old.
    expect(seen.worktrees).toEqual([])
    expect(seen.teammates).toEqual([{ handle: 'bob', publicKey: pair.bobKey, connected: false, heardAt: null }])
  })

  it('opens with what it knew last time, before anything has connected', async () => {
    const cachePath = await freshCachePath()
    const firstRun = await TeammateCacheStore.open(cachePath, { now: () => CLOCK_START })
    const pair = await pairOfRuntimes({ aliceCache: firstRun })
    await connect(pair)
    expect(bobsRows(pair.alice).map((row) => row.live)).toEqual([true])

    // Everything in memory goes; only the bytes on disk survive, and they are
    // read by a store that has never seen this session.
    pair.alice.service.stop()
    pair.bob.service.stop()
    await firstRun.flush()
    const written = await TeammateCacheStore.open(cachePath, { now: () => CLOCK_START })
    const revived = await reopenAlice(pair, written)
    pair.relay.pause()
    await revived.service.start()
    await pair.scheduler.advance(0)

    const seen = presenceOf(revived.service, 'p_alice')
    expect(seen.worktrees.map((row) => [row.handle, row.name, row.live])).toEqual([['bob', 'flaky test', false]])
    // It is a picture, not a claim: nobody is connected and the standing says so.
    expect(seen.teammates.map((teammate) => teammate.connected)).toEqual([false])
  })

  it('writes that cache beside the workspace, in the app’s own data directory', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    const filePath = join(pair.alice.dataDir, TEAMMATE_CACHE_FILE)
    await untilOnDisk(filePath)
    expect((await stat(filePath)).isFile()).toBe(true)
  })

  it('stops showing a worktree the teammate removed while they were away', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(bobsRows(pair.alice).map((row) => row.name)).toEqual(['flaky test'])

    pair.bob.service.stop()
    await pair.scheduler.advance(100)
    // Away, so the row is still there. This is the case the cache exists for.
    expect(bobsRows(pair.alice).map((row) => row.name)).toEqual(['flaky test'])

    pair.bob.workspace.worktrees = [worktree('wt_b2', 'p_bob', 'retry budget', 'fix/retry')]
    pair.bob.workspace.terminals = []
    await pair.bob.service.start()
    await pair.scheduler.advance(120_000)

    // Their snapshot is the whole of what they have, so the one they deleted is
    // gone rather than remembered. A cache that merged would keep it forever.
    expect(bobsRows(pair.alice).map((row) => [row.name, row.live])).toEqual([['retry budget', true]])
  })

  it('comes back without the sidebar passing through empty on the way', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    const counts: number[] = []
    const watch = (): void => {
      counts.push(presenceOf(pair.alice.service, 'p_alice').worktrees.length)
    }

    watch()
    pair.relay.closeAll(RelayCloseCode.GoingAway, 'going away')
    watch()
    await pair.scheduler.advance(5_000)
    watch()

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    // Never zero, at any point: reconnection reconciles what is on screen, and
    // does not rebuild it from nothing.
    expect(counts).toEqual([1, 1, 1])
    expect(bobsRows(pair.alice).map((row) => row.live)).toEqual([true])
  })

  it('will not let a cached snapshot be read as a live one, however the link is going', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    // The relay is gone, so the link is trying and failing rather than parked.
    pair.relay.pause()
    pair.relay.closeAll(RelayCloseCode.GoingAway, 'going away')
    await pair.scheduler.advance(30_000)

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).not.toBe('connected')
    expect(bobsRows(pair.alice).every((row) => row.live)).toBe(false)
    expect(presenceOf(pair.alice.service, 'p_alice').teammates.map((one) => one.connected)).toEqual([false])
  })
})

describe('the rendezvous derivation', () => {
  it('puts the token’s hash in the URL and the token in the frame, never the reverse', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const token = pair.relay.greetings()[0]!
    // The fake relay only accepts a URL whose last segment is the hash, so the
    // pairing above already proves the split; this pins which way round it is.
    expect(rendezvousId(token)).toHaveLength(64)
    expect(rendezvousId(token)).not.toBe(token)
  })

  it('derives the same token on both sides and a different one each hour', () => {
    const a = new Uint8Array(32).fill(7)
    const secret = sharedSecret(a, Buffer.from(new Uint8Array(32).fill(9)).toString('base64'))
    const project = 'c'.repeat(64)
    const now = 1_700_000_000_000
    expect(rendezvousToken(secret, project, epochAt(now))).not.toBe(rendezvousToken(secret, project, epochAt(now) + 1))
    expect(rendezvousToken(secret, project, epochAt(now))).toBe(rendezvousToken(secret, project, epochAt(now)))
  })

  it('agrees with the relay’s URL shape', () => {
    const token = 'a'.repeat(64)
    expect(rendezvousId(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('a snapshot from a teammate is somebody else’s bytes', () => {
  it('refuses one that is not a snapshot, and says so rather than freezing the sidebar', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(bobsRows(pair.alice).map((row) => row.name)).toEqual(['flaky test'])

    // Passes a check of the two outer fields and blows up at the first lookup
    // inside. Believed, it poisons what is held for this link: every later read
    // throws and the sidebar sits on yesterday's picture with nothing saying why.
    answerPresenceWith(pair.bob, { revision: 9_999, projects: [null] })
    pair.bob.changed()
    await pair.scheduler.advance(1_000)

    expect(() => presenceOf(pair.alice.service, 'p_alice')).not.toThrow()
    expect(bobsRows(pair.alice).map((row) => row.name)).toEqual(['flaky test'])
    expect(pair.alice.errors().map(String).join()).toContain('was not a snapshot')

    // And still refused ten minutes later: a refusal that wore off would be a
    // wedge with a delay on it.
    await pair.scheduler.advance(600_000)
    expect(() => presenceOf(pair.alice.service, 'p_alice')).not.toThrow()
  })

  it('keeps a teammate’s snapshot inside this machine’s own bounds', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    // Large, and deliberately inside the 4 MiB a peer frame may be: this is a
    // snapshot that really does cross the wire, not one too big to send.
    const long = 'w'.repeat(2_000)
    const longish = 'p'.repeat(300)
    answerPresenceWith(pair.bob, {
      revision: 5,
      handle: 'bob',
      projects: [
        {
          projectKey: projectKeyFor(normaliseRemote(ORIGIN)!),
          worktrees: Array.from({ length: 60 }, (_unused, index) => ({
            id: `wt_${index}`,
            name: long,
            branch: long,
            state: 'ready',
            panes: Array.from({ length: 50 }, (_ignored, pane) => ({
              id: `t_${index}_${pane}`,
              title: longish,
              shell: longish,
              running: true,
              busy: false,
              quietForMs: 0
            }))
          }))
        }
      ]
    })
    pair.bob.changed()
    await pair.scheduler.advance(1_000)

    const rows = presenceOf(pair.alice.service, 'p_alice').worktrees
    // The cache's numbers rather than a second set, so memory and disk agree.
    expect(rows).toHaveLength(MAX_CACHED_WORKTREES)
    expect(rows[0]?.panes).toHaveLength(MAX_CACHED_PANES)
    expect(Math.max(...rows.map((row) => row.name.length))).toBe(MAX_CACHED_TEXT)
    expect(Math.max(...rows.flatMap((row) => row.panes.map((pane) => pane.title.length)))).toBe(MAX_CACHED_TEXT)
  })

  it('refuses a worktree list with a hole in it rather than the elements it can read', () => {
    const projectKey = 'k'.repeat(64)
    const worktrees = [{ id: 'wt_1', name: 'one', branch: 'main', state: 'ready', panes: [] }, null]
    expect(parsePeerPresence({ revision: 1, handle: 'bob', projects: [{ projectKey, worktrees }] }, projectKey)).toBe(
      undefined
    )
    // A worktree missing its panes is the other half of the same bug: the loop
    // that read it threw where the lookup above did.
    expect(
      parsePeerPresence(
        { revision: 1, handle: 'bob', projects: [{ projectKey, worktrees: [{ id: 'wt_1', name: 'one' }] }] },
        projectKey
      )
    ).toBe(undefined)
  })

  it('shows a pane running a harness this build has never heard of as a plain terminal', () => {
    const projectKey = 'k'.repeat(64)
    const pane = { title: 'zsh', shell: '/bin/zsh', running: true, busy: false, quietForMs: 0 }
    const worktrees = [
      {
        id: 'wt_1',
        name: 'one',
        branch: 'main',
        state: 'ready',
        panes: [
          { ...pane, id: 't_new', agent: 'harness-from-next-year' },
          { ...pane, id: 't_known', agent: 'claude' }
        ]
      }
    ]
    const panes = parsePeerPresence({ revision: 1, handle: 'bob', projects: [{ projectKey, worktrees }] }, projectKey)
      ?.projects[0]?.worktrees[0]?.panes
    expect(panes?.map((one) => [one.id, one.agent])).toEqual([
      ['t_new', undefined],
      ['t_known', 'claude']
    ])
  })

  it('keeps only the repository the session is for, however many a snapshot names', () => {
    const ours = 'a'.repeat(64)
    const theirs = 'b'.repeat(64)
    const snapshot = {
      revision: 2,
      handle: 'bob',
      projects: [
        { projectKey: theirs, worktrees: [] },
        { projectKey: ours, worktrees: [] }
      ]
    }
    expect(parsePeerPresence(snapshot, ours)?.projects.map((one) => one.projectKey)).toEqual([ours])
    expect(parsePeerPresence(snapshot, 'c'.repeat(64))?.projects).toEqual([])
  })
})

/**
 * Lets one session run long enough to count as healthy, has the relay break it,
 * and returns how long the link waited. Jitter is fixed at 1, so two can be compared.
 */
async function breakOneSession(pair: Pair, middle: { arm: () => void }): Promise<number> {
  await pair.scheduler.advance(HEALTHY_SESSION_MS)
  middle.arm()
  await pair.scheduler.advance(KEEPALIVE_MS)
  expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).not.toBe('connected')

  let waited = 0
  while (waited < BACKOFF_CEILING_MS) {
    await pair.scheduler.advance(RECONNECT_FLOOR_MS)
    waited += RECONNECT_FLOOR_MS
    if (linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase === 'connected') break
  }
  return waited
}

describe('a frame that does not authenticate', () => {
  it('does not report the relay corrupting a frame as the teammate dropping the connection', async () => {
    // A frame that fails to authenticate is the untrusted relay's one symptom;
    // blaming the teammate points at the only party nothing is established about.
    const middle = relayThatChangesAByte()
    const pair = await pairOfRuntimes({ bobDial: middle.wrap })
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    middle.arm()
    await pair.scheduler.advance(KEEPALIVE_MS)

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.detail).not.toBe('your teammate’s machine dropped the connection')
    expect(link?.detail).toBe(UNAUTHENTICATED_DETAIL)
  })

  it('leaves the operator a trace of it, rather than swallowing the reason', async () => {
    // A relay quietly corrupting every session looks like a teammate with a bad
    // network, unless the reason reaches somewhere it can be read.
    const middle = relayThatChangesAByte()
    const pair = await pairOfRuntimes({ bobDial: middle.wrap })
    await connect(pair)

    middle.arm()
    await pair.scheduler.advance(KEEPALIVE_MS)

    const said = pair.alice.errors().map((error) => (error instanceof Error ? error.message : String(error)))
    expect(said.some((message) => /authentication failed/.test(message))).toBe(true)
  })

  it('makes a relay that corrupts every session pay more each time, not once a second forever', async () => {
    // Each session ran a full `HEALTHY_SESSION_MS` before the relay broke it,
    // which used to reset the backoff: a fresh X25519 handshake per second per
    // link, for ever, while the screen blamed the teammate.
    const middle = relayThatChangesAByte()
    const pair = await pairOfRuntimes({ bobDial: middle.wrap })
    await connect(pair)

    const first = await breakOneSession(pair, middle)
    const second = await breakOneSession(pair, middle)

    expect(first).toBeGreaterThanOrEqual(RECONNECT_FLOOR_MS)
    expect(second).toBeGreaterThan(first)
  })
})

describe('a rendezvous that paired and then went nowhere', () => {
  /** Pairs the two peers on the relay and lets nothing binary through. */
  async function pairedButHeld(): Promise<Pair> {
    const pair = await pairOfRuntimes()
    await pair.alice.service.start()
    await pair.bob.service.start()
    pair.relay.holdContent()
    await pair.scheduler.advance(0)
    return pair
  }

  it('stops saying nobody has answered once the relay has said somebody has', async () => {
    // The relay sent `paired` and this side went on showing the sentence for an
    // empty rendezvous for the whole of the handshake.
    const pair = await pairedButHeld()

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.detail).not.toBe(WAITING_DETAIL)
  })

  it('does not call a handshake that never finished a teammate dropping the connection', async () => {
    // A relay that pairs and then withholds frames ran out the handshake
    // deadline; this side's own close came back `paired` and was read as the
    // teammate hanging up. Nobody hung up: nothing ever arrived.
    const pair = await pairedButHeld()

    await pair.scheduler.advance(HANDSHAKE_TIMEOUT_MS)

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.detail).not.toBe('your teammate’s machine dropped the connection')
    expect(link?.detail).toBe(HANDSHAKE_STALLED_DETAIL)
  })

  it('still says the teammate dropped when a connected link really is hung up on', async () => {
    // The fix must not become a way of never saying it.
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    pair.bob.service.stop()
    await pair.scheduler.advance(100)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBe('your teammate’s machine dropped the connection')
  })
})

describe('a close the relay sends for a condition of its own', () => {
  it('comes back from a 4008 instead of losing the teammate until the app restarts', async () => {
    // 4008 is a protocol error, but the relay also sends it when its own pairing
    // table cannot read the other socket. The link stopped for good on it and
    // `reconcile()` skips a link it already holds, so the teammate was gone
    // until the app was restarted.
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    pair.relay.closeAll(RelayCloseCode.Protocol, 'no partner for a paired connection')
    await pair.scheduler.advance(0)
    // Still recorded and reported; what changed is that it is no longer for ever.
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('stopped')

    await pair.scheduler.advance(STOPPED_RETRY_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })

  it('waits a long time before doing so, so a relay that means it is not hammered', async () => {
    // These codes are ones a reconnect cannot fix, so coming back must cost far
    // more than an ordinary drop: looking again, not retrying.
    const pair = await pairOfRuntimes()
    await connect(pair)

    pair.relay.closeAll(RelayCloseCode.Protocol, 'no partner for a paired connection')
    await pair.scheduler.advance(0)

    await pair.scheduler.advance(BACKOFF_CEILING_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('stopped')
  })

  it('does not go on blaming a frame this client sent, which it cannot know', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    pair.relay.closeAll(RelayCloseCode.Protocol, 'no partner for a paired connection')
    await pair.scheduler.advance(0)

    const detail = linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail ?? ''
    expect(detail).not.toBe('the relay refused a frame this client sent')
    // Both of the things it could be, because this end cannot tell them apart.
    expect(detail).toContain('this client sent')
    expect(detail).toContain('its own record')
  })
})

describe('what a dropped session costs the side it dropped on', () => {
  it('makes a teammate who confirms and drops in a loop pay for the loop', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    // Sixty dial-handshake-confirm-drop cycles from Bob's end. Each costs Alice
    // a Diffie-Hellman and a socket: the clock does not move, and she must not dial.
    const startedAt = pair.scheduler.now()
    const before = pair.relay.greetings().length
    for (let cycle = 0; cycle < 60; cycle += 1) {
      pair.bob.service.stop()
      await pair.bob.service.start()
      await pair.scheduler.advance(0)
    }

    expect(pair.scheduler.now()).toBe(startedAt)
    // Bob's own sixty hellos, and not one of Alice's.
    expect(pair.relay.greetings().length - before).toBe(60)

    // And she is not stopped either: the wait grows, it does not become never.
    await pair.scheduler.advance(600_000)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })

  it('forgives the backoff of a session that lasted, so an ordinary drop comes back at once', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    // A working afternoon, and then the teammate's laptop closes.
    await pair.scheduler.advance(600_000)
    pair.relay.closeAll(RelayCloseCode.PartnerGone, 'partner disconnected')

    await pair.scheduler.advance(2_000)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })
})

describe('what a teammate may hold open', () => {
  it('replaces a teammate’s presence stream when they subscribe again, rather than stranding the first', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const connection = linkIdFor(pair.aliceKey, projectKeyFor(normaliseRemote(ORIGIN)!))
    expect(pair.bob.subscriptions.countFor(connection)).toBe(1)

    // The subscriber map is keyed by connection, so a second subscribe used to
    // leave the first registered in the hub: unreachable until the link dropped.
    const first: unknown[] = []
    const second: unknown[] = []
    const watch =
      (into: unknown[]) =>
      (channel: SubscriptionChannel): (() => void) =>
        pair.bob.service.peerSubscribe(connection, {
          emit: (event) => {
            into.push(event)
            channel.emit(event)
          },
          close: () => channel.close()
        })

    pair.bob.subscriptions.subscribe(connection, watch(first))
    pair.bob.subscriptions.subscribe(connection, watch(second))
    expect(pair.bob.subscriptions.countFor(connection)).toBe(1)

    const opened = [first.length, second.length]
    pair.bob.changed()
    await pair.scheduler.advance(1_000)
    expect(first.length - opened[0]!).toBe(0)
    expect(second.length - opened[1]!).toBe(1)
  })

  it('refuses a teammate a new stream once they hold too many, however many times they ask', async () => {
    const pair = await pairOfRuntimes()
    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    const alice = await rawLink({
      relay: pair.relay,
      scheduler: pair.scheduler,
      dataDir: pair.alice.dataDir,
      remotePublicKey: pair.bobKey,
      handle: 'alice'
    })
    expect(alice.phase()).toBe('connected')

    const connection = linkIdFor(pair.aliceKey, projectKeyFor(normaliseRemote(ORIGIN)!))
    for (let call = 0; call < MAX_PEER_SUBSCRIPTIONS * 4; call += 1) {
      await alice.link.call('peer.subscribe', {})
    }
    await pair.scheduler.advance(0)

    // One, because a repeat replaces, and never past the cap: every record is a
    // buffer this machine keeps on somebody else's say-so.
    expect(pair.bob.subscriptions.countFor(connection)).toBe(1)
    expect(pair.bob.subscriptions.countFor(connection)).toBeLessThanOrEqual(MAX_PEER_SUBSCRIPTIONS)
    alice.link.stop()
  })

  it('ends a stream a teammate asked to end, and stops sending on it', async () => {
    const pair = await pairOfRuntimes()
    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    const alice = await rawLink({
      relay: pair.relay,
      scheduler: pair.scheduler,
      dataDir: pair.alice.dataDir,
      remotePublicKey: pair.bobKey,
      handle: 'alice'
    })
    expect(alice.phase()).toBe('connected')

    const events: unknown[] = []
    const { subscription } = await alice.link.call('peer.subscribe', {})
    const stop = alice.link.route(subscription, (event) => events.push(event))
    const connection = linkIdFor(pair.aliceKey, projectKeyFor(normaliseRemote(ORIGIN)!))
    expect(pair.bob.subscriptions.countFor(connection)).toBe(1)

    pair.bob.changed()
    await pair.scheduler.advance(1_000)
    const delivered = events.length
    expect(delivered).toBeGreaterThan(0)

    // The third method on a teammate's allow-list, used the way a teammate uses
    // it: their own id, over their own link, releasing their own stream.
    await expect(alice.link.call('unsubscribe', { subscription })).resolves.toEqual({ unsubscribed: true })
    expect(pair.bob.subscriptions.countFor(connection)).toBe(0)

    pair.bob.changed()
    await pair.scheduler.advance(1_000)
    expect(events).toHaveLength(delivered)
    stop()
    alice.link.stop()
  })
})

describe('what a stream costs before anybody has claimed it', () => {
  it('says what it threw away when a stream outruns the hold buffer', async () => {
    const pair = await pairOfRuntimes()
    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    const alice = await rawLink({
      relay: pair.relay,
      scheduler: pair.scheduler,
      dataDir: pair.alice.dataDir,
      remotePublicKey: pair.bobKey,
      handle: 'alice'
    })
    expect(alice.phase()).toBe('connected')

    // One of Bob's streams Alice has not routed: the window every subscription
    // opens with, while the answer naming it is still on the wire. Held open by
    // hand, since a stalled relay handing over its backlog reaches the same state.
    const connection = linkIdFor(pair.aliceKey, projectKeyFor(normaliseRemote(ORIGIN)!))
    let channel: SubscriptionChannel | undefined
    const subscription = pair.bob.subscriptions.subscribe(connection, (opened) => {
      channel = opened
      return () => {}
    })

    const chunk = 'x'.repeat(64)
    const over = 4
    for (let frame = 0; frame < MAX_UNROUTED_EVENTS + over; frame += 1) {
      channel?.emit({ type: 'data', data: chunk })
      // A flush apart, so each chunk is its own frame rather than merged into
      // the one in front of it by Bob's pacer.
      await pair.scheduler.advance(STREAM_FLUSH_MS)
    }

    const events: unknown[] = []
    const stop = alice.link.route(subscription, (event) => events.push(event))

    // Bounded, and said: a reader shown the rest with no mark where the four
    // frames were would be reading a transcript that never happened.
    expect(events[0]).toEqual({ type: 'elided', bytes: over * 64 })
    expect(events).toHaveLength(MAX_UNROUTED_EVENTS + 1)
    expect(events.slice(1)).toEqual(Array.from({ length: MAX_UNROUTED_EVENTS }, () => ({ type: 'data', data: chunk })))

    stop()
    pair.bob.subscriptions.unsubscribe(connection, subscription)
    alice.link.stop()
  })
})

describe('what a stream costs when there are already too many of them', () => {
  /** A link of Alice's onto Bob, plus a way of opening streams on Bob that Alice has not routed. */
  async function rigWithStreams(pair: Pair): Promise<{
    alice: { link: PeerLink; phase: () => string }
    open: () => { id: string; emit: (event: unknown) => void; end: () => void }
  }> {
    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    const alice = await rawLink({
      relay: pair.relay,
      scheduler: pair.scheduler,
      dataDir: pair.alice.dataDir,
      remotePublicKey: pair.bobKey,
      handle: 'alice'
    })
    expect(alice.phase()).toBe('connected')
    const connection = linkIdFor(pair.aliceKey, projectKeyFor(normaliseRemote(ORIGIN)!))
    return {
      alice,
      open: () => {
        let channel: SubscriptionChannel | undefined
        const id = pair.bob.subscriptions.subscribe(connection, (opened) => {
          channel = opened
          return () => {}
        })
        return {
          id,
          emit: (event) => channel?.emit(event as never),
          end: () => pair.bob.subscriptions.unsubscribe(connection, id)
        }
      }
    }
  }

  it('says what it lost when a stream arrives past the stream bound, instead of nothing', async () => {
    // The event bound hands out an `elided`; the *stream* bound did not: the
    // seventeenth unclaimed stream was dropped with nothing written down, so the
    // watcher silently missed the head of the pane it had just asked for.
    const pair = await pairOfRuntimes()
    const { alice, open } = await rigWithStreams(pair)

    const streams = Array.from({ length: MAX_UNROUTED_STREAMS + 1 }, () => open())
    const chunk = 'y'.repeat(32)
    for (const stream of streams) {
      stream.emit({ type: 'data', data: chunk })
      await pair.scheduler.advance(STREAM_FLUSH_MS)
    }

    const last = streams[streams.length - 1]!
    const events: unknown[] = []
    const stop = alice.link.route(last.id, (event) => events.push(event))

    expect(events[0]).toEqual({ type: 'elided', bytes: chunk.length })

    stop()
    for (const stream of streams) stream.end()
    alice.link.stop()
  })

  it('lets go of a stream nobody ever claimed, so a later one is not punished for it', async () => {
    // An `unrouted` entry was only ever removed by `route`, so a
    // `terminal.subscribe` that timed out held one of the sixteen slots for the
    // life of the link; enough of those and every later stream lost its head.
    const pair = await pairOfRuntimes()
    const { alice, open } = await rigWithStreams(pair)

    const abandoned = Array.from({ length: MAX_UNROUTED_STREAMS }, () => open())
    const chunk = 'z'.repeat(32)
    for (const stream of abandoned) {
      stream.emit({ type: 'data', data: chunk })
      await pair.scheduler.advance(STREAM_FLUSH_MS)
    }

    // Past the longest a call may take to be answered: nothing is coming to claim these.
    await pair.scheduler.advance(PEER_CALL_TIMEOUT_MS)

    const wanted = open()
    wanted.emit({ type: 'data', data: chunk })
    await pair.scheduler.advance(STREAM_FLUSH_MS)

    const events: unknown[] = []
    const stop = alice.link.route(wanted.id, (event) => events.push(event))
    // Whole: its head is there and there is no hole in front of it.
    expect(events).toEqual([{ type: 'data', data: chunk }])

    stop()
    for (const stream of [...abandoned, wanted]) stream.end()
    alice.link.stop()
  })
})

describe('the name a link is kept under', () => {
  it('carries both keys whole, so two teammates cannot be filed as one', () => {
    const key = `${'A'.repeat(43)}=`
    const projectKey = 'b'.repeat(64)
    expect(linkIdFor(key, projectKey)).toContain(key)
    expect(linkIdFor(key, projectKey)).toContain(projectKey)
    // Two keys that agree for as far as the id used to reach are still two.
    const neighbour = `${key.slice(0, 40)}zz=`
    expect(linkIdFor(neighbour, projectKey)).not.toBe(linkIdFor(key, projectKey))
  })
})

describe('a teammate whose machine stopped answering', () => {
  it('stops saying connected once nothing has decrypted for the deadline', async () => {
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    lid.sleep()

    // One keepalive interval of silence is what a healthy link spends between frames.
    await pair.scheduler.advance(KEEPALIVE_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    // Past the deadline the socket is still open on both hosts; only this side knows.
    await pair.scheduler.advance(SILENCE_TIMEOUT_MS)
    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.phase).not.toBe('connected')
    // And through the reconnect and park that follow: a teammate who stopped is
    // not the same wait as a rendezvous nobody has ever answered.
    expect(link?.detail).toBe(SILENT_PEER_DETAIL)
    await pair.scheduler.advance(3_600_000)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBe(SILENT_PEER_DETAIL)
  })

  it('carries the age of its silence for the minutes before the deadline, and not before that', async () => {
    // `since` is when the phase last moved, so a link silent for four minutes
    // used to be indistinguishable from one that is fine.
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.lastHeardAt).toBeUndefined()

    lid.sleep()
    // Just inside the threshold there is still nothing to say.
    await pair.scheduler.advance(LINK_QUIET_AFTER_MS - 1)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.lastHeardAt).toBeUndefined()

    await pair.scheduler.advance(1)
    const quiet = linkTo(pair.alice, 'p_alice', pair.bobKey)
    // Still connected, and now saying when anything from Bob last decrypted.
    expect(quiet?.phase).toBe('connected')
    // A timestamp rather than a duration: the sidebar ticks on its own clock
    // and is only handed a link when something changes.
    expect(quiet?.lastHeardAt).toBe(CLOCK_START)
    expect(pair.scheduler.now() - (quiet?.lastHeardAt ?? 0)).toBe(LINK_QUIET_AFTER_MS)
  })

  it('measures that age on a clock a stepped wall clock cannot move', async () => {
    // A wall clock that steps (NTP, somebody changing the time) lengthens a
    // `Date.now()` difference without a second of silence passing. The step is
    // inside `CLOCK_JUMP_TOLERANCE_MS`, so no deadline withdraws its verdict
    // and only the right clock rescues the number.
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)

    lid.sleep()
    const step = CLOCK_JUMP_TOLERANCE_MS - 1_000
    await pair.scheduler.sleep(step, 'uncounted')
    await pair.scheduler.advance(LINK_QUIET_AFTER_MS)

    const quiet = linkTo(pair.alice, 'p_alice', pair.bobKey)
    // The step is not part of the age: exactly the threshold, not the threshold
    // plus somebody else's clock correction.
    expect(quiet?.phase).toBe('connected')
    expect(pair.scheduler.now() - (quiet?.lastHeardAt ?? 0)).toBe(LINK_QUIET_AFTER_MS)
  })

  it('stops carrying an age at all once this machine turns out to be the one that was away', async () => {
    // A link four minutes silent carries a number; then the lid shuts. On waking
    // that number would read as an hour of the teammate's silence, so there is no number.
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)

    lid.sleep()
    await pair.scheduler.advance(LINK_QUIET_AFTER_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.lastHeardAt).toBeDefined()

    await pair.scheduler.sleep(3_600_000, 'counted')

    const woken = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(woken?.detail).toBe(WOKE_DETAIL)
    expect(woken?.lastHeardAt).toBeUndefined()
  })

  it('says nothing new about a link that is talking, however long it has been up', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    // A gap of one whole interval is what healthy looks like, which is why the
    // threshold sits past one.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await pair.scheduler.advance(KEEPALIVE_MS)
      const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
      expect(link?.phase).toBe('connected')
      expect(link?.lastHeardAt).toBeUndefined()
    }
  })

  it('stops carrying an age the moment the teammate is heard from again', async () => {
    const lid = stalledLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)

    lid.stall()
    await pair.scheduler.advance(LINK_QUIET_AFTER_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.lastHeardAt).toBeDefined()

    // Inside the deadline, so there is still a link to come back to; "last
    // heard 3m ago" about somebody who just answered is the same untruth the other way.
    lid.resume()
    await pair.scheduler.advance(0)
    const woken = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(woken?.phase).toBe('connected')
    expect(woken?.lastHeardAt).toBeUndefined()
  })

  it('says nothing about a machine it has never heard from, because it cannot know', async () => {
    // Two people on different relays each wait here while the other is
    // connected somewhere else; all that is known is that nobody has answered.
    const pair = await pairOfRuntimes()
    await pair.alice.service.start()
    await pair.scheduler.advance(0)

    const detail = linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail
    expect(detail).toBe(WAITING_DETAIL)
    expect(detail).not.toMatch(/machine/)
  })

  it('marks the rows it was showing stale and dated, and keeps every one of them', async () => {
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)
    const before = bobsRows(pair.alice)
    expect(before.map((row) => row.live)).toEqual([true])

    lid.sleep()
    await pair.scheduler.advance(SILENCE_TIMEOUT_MS + KEEPALIVE_MS)

    const after = bobsRows(pair.alice)
    // Not one row fewer, not a heardAt moved: a vanished row reads as a deleted
    // worktree, and a row still marked live is the worse error.
    expect(after.map((row) => row.name)).toEqual(before.map((row) => row.name))
    expect(after.map((row) => row.heardAt)).toEqual(before.map((row) => row.heardAt))
    // `live` is the whole of what `teammateStaleness` reads, so this is the
    // badge and the date, asserted where they are decided.
    expect(after.every((row) => row.live)).toBe(false)
  })

  it('settles a keystroke that was in flight rather than holding it for ever', async () => {
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)
    const paneId = bobsPaneId(pair.alice)

    lid.sleep()
    // Typed at a pane the screen still says is there. `WatchedPaneView` prints a
    // refusal from a rejection handler; a promise that never settles prints nothing.
    const outcome = pair.alice.service.type({ projectId: 'p_alice', paneId, data: 'yes\r' }).then(
      () => 'answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )

    await pair.scheduler.advance(SILENCE_TIMEOUT_MS + KEEPALIVE_MS)
    const said = await outcome
    expect(said).not.toBe('answered')
    expect(said).toMatch(/did not answer/)
  })

  it('tells an open watch it has ended instead of leaving a window that stopped moving', async () => {
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)
    const paneId = bobsPaneId(pair.alice)

    lid.sleep()
    const opened = pair.alice.service.openWatch({ projectId: 'p_alice', paneId })
    const sink = recorder()
    const stop = opened.start(sink.channel)

    // Nothing at all, which is the shape of the bug: the subscribe went out and
    // there is nobody to answer it, so the viewer sits on "Opening bob's pane".
    await pair.scheduler.advance(0)
    expect(sink.events).toEqual([])

    await pair.scheduler.advance(SILENCE_TIMEOUT_MS + KEEPALIVE_MS)
    expect(sink.events.map((event) => (event as { type?: unknown }).type)).toContain('lost')
    stop()
  })
})

describe('a machine that was asleep itself', () => {
  /** Longer than the silence deadline by an order of magnitude, which is what a closed lid looks like. */
  const A_CLOSED_LID_MS = 3_600_000

  it('does not say the teammate stopped answering when this machine slept through it', async () => {
    // The macOS shape: the monotonic clock counts time spent suspended, so every
    // overdue timer fires at once on waking.
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    await pair.scheduler.sleep(A_CLOSED_LID_MS, 'counted')

    // Bob did nothing wrong and nothing on this screen may say he did.
    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.detail).not.toBe(SILENT_PEER_DETAIL)
    expect(link?.detail).toBe(WOKE_DETAIL)
    // Nor is it quietly called healthy: an hour-old confirmation is not one.
    expect(link?.phase).not.toBe('connected')
  })

  it('does not blame a teammate for the silence of a socket that died in the sleep', async () => {
    // This machine sleeps, its socket does not survive it, and the deadline
    // fires on waking: the silence belongs to the lid, not to Bob.
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)
    lid.sleep()

    await pair.scheduler.sleep(A_CLOSED_LID_MS, 'counted')

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.detail).not.toBe(SILENT_PEER_DETAIL)
    expect(link?.detail).toBe(WOKE_DETAIL)
  })

  it('does not say it either where the monotonic clock ignored the sleep', async () => {
    // The other platform shape: the timers still owe their wait, and only the
    // wall clock has run away from them.
    const pair = await pairOfRuntimes()
    await connect(pair)

    await pair.scheduler.sleep(A_CLOSED_LID_MS, 'uncounted')
    // Nothing is overdue on that clock, so the sleep surfaces at the next
    // deadline: the keepalive tick.
    await pair.scheduler.advance(KEEPALIVE_MS)

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.detail).not.toBe(SILENT_PEER_DETAIL)
    expect(link?.detail).toBe(WOKE_DETAIL)
  })

  it('treats what the teammate was showing as unknown, then goes and re-establishes it', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const before = bobsRows(pair.alice)
    expect(before.map((row) => row.live)).toEqual([true])

    await pair.scheduler.sleep(A_CLOSED_LID_MS, 'counted')

    // Kept, dated, and not live.
    const during = bobsRows(pair.alice)
    expect(during.map((row) => row.name)).toEqual(before.map((row) => row.name))
    expect(during.some((row) => row.live)).toBe(false)

    // And the link dials again rather than sitting on a withdrawn verdict.
    await pair.scheduler.advance(KEEPALIVE_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBeUndefined()
    expect(bobsRows(pair.alice).every((row) => row.live)).toBe(true)
  })

  it('still says the teammate stopped answering when that is what happened', async () => {
    // The fix must not be a way of never blaming anybody. This machine sleeps,
    // comes back, re-establishes — and *then* Bob shuts his lid.
    const lid = sleepingLid()
    const pair = await pairOfRuntimes({ bobDial: lid.wrap })
    await connect(pair)

    await pair.scheduler.sleep(A_CLOSED_LID_MS, 'counted')
    await pair.scheduler.advance(KEEPALIVE_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    lid.sleep()
    await pair.scheduler.advance(SILENCE_TIMEOUT_MS + KEEPALIVE_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.detail).toBe(SILENT_PEER_DETAIL)
  })

  it('acts on the operating system saying so, without waiting for a deadline', async () => {
    // What `powerMonitor` is for: the same conclusion at wake rather than at the
    // next deadline. Injected because there is no Electron in this suite.
    let resume = (): void => {}
    const relay = createFakeRelay()
    const pair = await pairOfRuntimes({
      relay,
      aliceWatchWake: (onWake) => {
        resume = onWake
        return Promise.resolve(() => {})
      }
    })
    await connect(pair)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')

    resume()
    await pair.scheduler.advance(0)
    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.phase).not.toBe('connected')
    expect(link?.detail).toBe(WOKE_DETAIL)

    await pair.scheduler.advance(KEEPALIVE_MS)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })
})
