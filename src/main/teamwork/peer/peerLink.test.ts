// Two runtimes, two data directories, two identities, and a relay between
// them. Every test here drives both sides at once, because a handshake asserted
// from one end is a handshake against a fixture.

import { describe, expect, it } from 'vitest'
import { loadIdentity } from '../identity'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  remoteRunner,
  makeProjectDir,
  project,
  terminal,
  worktree,
  type FakeRelay,
  type ManualScheduler,
  type PeerRuntime
} from './peerTestSupport'
import { isNewerPresence, linkIdFor } from './peerService'
import { normaliseRemote, projectKeyFor } from './projectKey'
import { HANDSHAKE_TIMEOUT_MS } from './peerLink'
import { RelayCloseCode } from './relayConnection'
import { epochAt, rendezvousId, rendezvousToken, sharedSecret } from './rendezvous'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@github.com:team/repo.git'

type Pair = {
  relay: FakeRelay
  scheduler: ManualScheduler
  alice: PeerRuntime
  bob: PeerRuntime
  aliceKey: string
  bobKey: string
}

/**
 * Two installations that have each other in their rosters, on one relay.
 *
 * The rosters are real files under `.teamree/members`, read by the real reader,
 * because "is this key on the roster" is the whole of the trust model and a
 * stubbed answer to it would not be testing anything.
 */
async function pairOfRuntimes(options: { relay?: FakeRelay; aliceSeesBob?: boolean } = {}): Promise<Pair> {
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
    workspace: {
      projects: [project('p_alice', aliceProject)],
      worktrees: [worktree('wt_a1', 'p_alice', 'search ranking', 'feat/ranking')],
      terminals: [terminal('t_a1', 'wt_a1', { agent: 'claude', busy: true, lastOutputAt: scheduler.now() })]
    }
  })
  const bob = await createPeerRuntime({
    ...shared,
    dataDir: bobData,
    workspace: {
      projects: [project('p_bob', bobProject)],
      worktrees: [worktree('wt_b1', 'p_bob', 'flaky test', 'fix/flake')],
      terminals: [terminal('t_b1', 'wt_b1', { agent: 'codex', lastOutputAt: scheduler.now() - 90_000 })]
    }
  })

  return { relay, scheduler, alice, bob, aliceKey, bobKey }
}

/** Brings both sides up and lets the handshake and the first snapshot settle. */
async function connect(pair: Pair): Promise<void> {
  await pair.alice.service.start()
  await pair.bob.service.start()
  await pair.scheduler.advance(0)
}

function linkTo(runtime: PeerRuntime, projectId: string, publicKey: string) {
  return runtime.service.status({ projectId }).links.find((link) => link.publicKey === publicKey)
}

describe('two peers over a relay', () => {
  it('completes the Noise handshake and shows each other’s worktrees', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
    expect(linkTo(pair.bob, 'p_bob', pair.aliceKey)?.phase).toBe('connected')

    const seenByAlice = pair.alice.service.presence({ projectId: 'p_alice' })
    expect(seenByAlice.worktrees.map((entry) => [entry.handle, entry.name, entry.branch])).toEqual([
      ['bob', 'flaky test', 'fix/flake']
    ])

    const seenByBob = pair.bob.service.presence({ projectId: 'p_bob' })
    expect(seenByBob.worktrees.map((entry) => [entry.handle, entry.name])).toEqual([['alice', 'search ranking']])
  })

  it('carries each pane’s agent and activity, and never a byte of its output', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    const [bobsWorktree] = pair.alice.service.presence({ projectId: 'p_alice' }).worktrees
    const [pane] = bobsWorktree?.panes ?? []
    expect(pane?.agent).toBe('codex')
    expect(pane?.running).toBe(true)
    expect(pane?.busy).toBe(false)
    // Silence crosses as a duration, because two machines do not agree about
    // what time it is and an instant from a fast clock renders as the future.
    expect(pane?.quietForMs).toBeGreaterThanOrEqual(90_000)
    // Nothing that could carry a line of terminal output is on the wire at all.
    expect(Object.keys(pane ?? {}).sort()).toEqual(
      ['agent', 'busy', 'id', 'quietForMs', 'running', 'shell', 'title'].sort()
    )
  })

  it('namespaces a teammate’s ids, so two installations cannot collide on one', async () => {
    const pair = await pairOfRuntimes()
    // Both sides happen to have generated the same local id, which is ordinary:
    // ids are per installation and nothing makes them unique across machines.
    pair.bob.workspace.worktrees[0]!.id = 'wt_a1'
    await connect(pair)

    const [seen] = pair.alice.service.presence({ projectId: 'p_alice' }).worktrees
    expect(seen?.id).not.toBe('wt_a1')
    expect(seen?.id.startsWith('peer:')).toBe(true)
  })

  it('refuses a peer whose static key is not in this project’s roster', async () => {
    // Alice's roster does not have Bob, so Alice opens no link to him at all and
    // Bob's dial finds nobody: not being a member is not being reachable.
    const pair = await pairOfRuntimes({ aliceSeesBob: false })
    await connect(pair)

    expect(pair.alice.service.status({ projectId: 'p_alice' }).links).toEqual([])
    expect(linkTo(pair.bob, 'p_bob', pair.aliceKey)?.phase).toBe('waiting')
    expect(pair.bob.service.presence({ projectId: 'p_bob' }).worktrees).toEqual([])
  })

  it('tells a teammate nothing about a project they are not a member of', async () => {
    const pair = await pairOfRuntimes()
    // A second repository Alice is in and Bob is not. Under the README's
    // pairwise scheme this would ride the same session as the shared one.
    const privateProject = await makeProjectDir([{ handle: 'alice', publicKey: pair.aliceKey }])
    pair.alice.workspace.projects.push(project('p_private', privateProject))
    pair.alice.workspace.worktrees.push(worktree('wt_secret', 'p_private', 'acquisition', 'feat/acq'))
    await connect(pair)

    // Refused twice over: the session is for one project because its rendezvous
    // and its prologue say so, and the roster is checked again where the data
    // is chosen.
    const shared = projectKeyFor(normaliseRemote(ORIGIN)!)
    const snapshot = pair.alice.service.peerPresence(linkIdFor(pair.bobKey, shared))
    expect(snapshot.projects).toHaveLength(1)
    expect(JSON.stringify(snapshot)).not.toContain('acquisition')

    // And there is no session the private one could have arrived over: a link
    // exists per repository, and Bob is on the roster of exactly one of them.
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
      // The same repository, checked out twice and added twice, which is an
      // ordinary thing to do.
      runner: remoteRunner({ [cloneA]: ORIGIN, [cloneB]: ORIGIN }),
      workspace: { projects: [project('p_a', cloneA), project('p_b', cloneB)], worktrees: [], terminals: [] }
    })
    await alice.service.start()
    await scheduler.advance(0)

    // One rendezvous, because the rendezvous is derived from the repository and
    // not from the local project row. Two links here would present the same
    // token and the relay would have them displace each other forever.
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

    expect(pair.alice.service.presence({ projectId: 'p_alice' }).worktrees).toEqual([])
    expect(pair.alice.service.status({ projectId: 'p_alice' }).links).toEqual([])
  })
})

describe('presence stays live', () => {
  it('sends a new snapshot when a worktree appears, without anyone asking', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(pair.alice.service.presence({ projectId: 'p_alice' }).worktrees).toHaveLength(1)

    pair.bob.workspace.worktrees.push(worktree('wt_b2', 'p_bob', 'second thing', 'feat/second'))
    pair.bob.changed()
    await pair.scheduler.advance(1_000)

    expect(pair.alice.service.presence({ projectId: 'p_alice' }).worktrees.map((w) => w.name)).toEqual([
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
    // A reply overtaken in flight, which is ordinary on a link with real
    // latency. Applying it would put the sidebar back into a past its sender
    // has already left, with nothing else coming to correct it.
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
    expect(pair.alice.service.presence({ projectId: 'p_alice' }).worktrees).toHaveLength(1)
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

  it('says a teammate who vanished is not connected, and forgets what they were showing', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    expect(pair.alice.service.presence({ projectId: 'p_alice' }).worktrees).toHaveLength(1)

    pair.bob.service.stop()
    await pair.scheduler.advance(100)

    const link = linkTo(pair.alice, 'p_alice', pair.bobKey)
    expect(link?.phase).toBe('waiting')
    // Milestone B does not keep a stale cache; E is where that is built. What it
    // must not do meanwhile is keep showing a snapshot as though it were live.
    expect(pair.alice.service.presence({ projectId: 'p_alice' }).worktrees).toEqual([])
  })

  it('pairs on the first try after one side reconnects over its own half-open session', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)

    // Bob's machine suspends: his old socket reads as open to the relay, and he
    // dials again. The relay cannot tell the two apart, so it ends the session
    // and both old peers get 4002 — which is a back-off, never an immediate
    // retry, or the two of them displace each other for as long as they run.
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

    // The relay pairs them and the handshake runs, but nothing is delivered:
    // every frame the two of them write is held. This is the state a replayer
    // leaves a responder in — the handshake completed, and nobody is there.
    pair.relay.holdContent()
    await pair.scheduler.advance(0)

    const stuck = linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase
    expect(stuck).not.toBe('connected')

    // Release them and the first authenticated frame confirms the keys.
    pair.relay.releaseContent()
    await pair.scheduler.advance(0)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).toBe('connected')
  })

  it('gives up on a handshake that completed and then said nothing', async () => {
    const pair = await pairOfRuntimes()
    pair.relay.holdContent()
    await pair.alice.service.start()
    await pair.bob.service.start()
    await pair.scheduler.advance(0)
    expect(linkTo(pair.alice, 'p_alice', pair.bobKey)?.phase).not.toBe('connected')

    // A session nobody can speak on must not hold its slot for ever. The
    // handshake deadline covers the unconfirmed window for exactly this.
    await pair.scheduler.advance(HANDSHAKE_TIMEOUT_MS + 1_000)
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

  it('never lets one hello reach the relay twice for the same pair of keys', async () => {
    const pair = await pairOfRuntimes()
    await connect(pair)
    const [aliceToken, bobToken] = pair.relay.greetings()
    // Both derived it independently from the same Diffie-Hellman, so they meet.
    expect(aliceToken).toBe(bobToken)
    expect(aliceToken).toMatch(/^[0-9a-f]{64}$/)
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
