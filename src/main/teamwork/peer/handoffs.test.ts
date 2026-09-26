// Handing a worktree over, between runtimes on a fake relay: the roster check, only the named
// teammate drawing the offer, `took` clearing it on the sender, and a dismissal that outlives a restart.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../../shared/protocol'
import { MAX_HANDOFF_NOTE_CHARS, MAX_HANDOFFS } from '../../../shared/presenceExtras'
import { loadIdentity } from '../identity'
import { linkIdFor, parsePeerPresence, PRESENCE_COALESCE_MS } from './peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  worktree
} from './peerTestSupport'
import { normaliseRemote, projectKeyFor } from './projectKey'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@example.invalid:team/repo.git'
const PROJECT_KEY = projectKeyFor(normaliseRemote(ORIGIN) as string)
const AUTH = { ...worktree('wt_auth', 'p_alice', 'Rework auth session', 'rework-auth'), task: 'Rework auth session' }

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Alice and Bob online on one relay; Carol is on the roster and never comes online. */
async function team(bobData?: string) {
  const relay = createFakeRelay()
  const scheduler = createManualScheduler()
  const aliceData = await mkdtemp(join(tmpdir(), 'teamree-alice-'))
  const bobDir = bobData ?? (await mkdtemp(join(tmpdir(), 'teamree-bob-')))
  const [aliceKey, bobKey, carolKey] = [
    (await loadIdentity(aliceData)).publicKey,
    (await loadIdentity(bobDir)).publicKey,
    (await loadIdentity(await mkdtemp(join(tmpdir(), 'teamree-carol-')))).publicKey
  ]
  const roster = [
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'bob', publicKey: bobKey },
    { handle: 'carol', publicKey: carolKey }
  ]
  const shared = {
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: fixedRemoteRunner(ORIGIN)
  }
  const alice = await createPeerRuntime({
    ...shared,
    dataDir: aliceData,
    workspace: { projects: [project('p_alice', await makeProjectDir(roster))], worktrees: [AUTH], terminals: [] }
  })
  const bobProject = await makeProjectDir(roster)
  const startBob = async (dataDir: string) => {
    const bob = await createPeerRuntime({
      ...shared,
      dataDir,
      workspace: { projects: [project('p_bob', bobProject)], worktrees: [], terminals: [] }
    })
    await bob.service.start()
    cleanups.push(() => bob.service.stop())
    return bob
  }
  await alice.service.start()
  cleanups.push(() => alice.service.stop())
  const bob = await startBob(bobDir)
  const settle = () => scheduler.advance(PRESENCE_COALESCE_MS * 4)
  await settle()
  return { alice, bob, bobDir, carolKey, startBob, settle }
}

describe('handing a worktree to a teammate', () => {
  it('refuses anyone who is not on the project’s roster, this machine included', async () => {
    const { alice } = await team()
    for (const to of ['mallory', 'alice']) {
      expect(() => alice.service.offerHandoff({ worktree: AUTH, to, note: '' })).toThrow(
        expect.objectContaining({ code: ErrorCode.NotFound, message: `${to} is not on this project’s roster` })
      )
    }
    expect(alice.service.handoffs({ projectId: 'p_alice' }).outgoing).toEqual([])
  })

  it('reaches only the teammate it names, under the name their roster gives the sender', async () => {
    const { alice, bob, carolKey, settle } = await team()
    const offered = alice.service.offerHandoff({ worktree: AUTH, to: 'bob', note: 'Finish the refresh path.' })
    await settle()

    expect(bob.service.handoffs({ projectId: 'p_bob' }).incoming).toEqual([
      {
        id: offered.id,
        to: 'bob',
        from: 'alice',
        worktreeName: 'Rework auth session',
        branch: 'rework-auth',
        note: 'Finish the refresh path.',
        at: offered.at
      }
    ])
    // Carol's snapshot carries nothing of it, and nothing crosses naming Alice's worktree id.
    expect(alice.service.peerPresence(linkIdFor(carolKey, PROJECT_KEY)).handoffs).toBeUndefined()
    expect(JSON.stringify(bob.service.handoffs({ projectId: 'p_bob' }).incoming)).not.toContain('wt_auth')
  })

  it('shows the sender “taken” once the teammate takes it, and stops offering it', async () => {
    const { alice, bob, settle } = await team()
    const offered = alice.service.offerHandoff({ worktree: AUTH, to: 'bob', note: 'Finish it.' })
    await settle()

    bob.service.settleHandoff('p_bob', offered.id, 'took')
    await settle()

    const [outgoing] = alice.service.handoffs({ projectId: 'p_alice' }).outgoing
    expect(outgoing).toMatchObject({ id: offered.id, to: 'bob', worktreeId: 'wt_auth' })
    expect(outgoing?.takenAt).toEqual(expect.any(Number))
    expect(bob.service.handoffs({ projectId: 'p_bob' }).incoming).toEqual([])
    expect(() => bob.service.incomingHandoff('p_bob', offered.id)).toThrow(/gone/)
  })

  it('forgets a dismissed offer on the teammate’s side only, across a restart', async () => {
    const { alice, bob, bobDir, startBob, settle } = await team()
    const offered = alice.service.offerHandoff({ worktree: AUTH, to: 'bob', note: '' })
    await settle()

    bob.service.settleHandoff('p_bob', offered.id, 'dismissed')
    await settle()
    expect(bob.service.handoffs({ projectId: 'p_bob' }).incoming).toEqual([])
    expect(alice.service.handoffs({ projectId: 'p_alice' }).outgoing[0]?.takenAt).toBeUndefined()

    await bob.service.flushHandoffs()
    bob.service.stop()
    const again = await startBob(bobDir)
    await settle()
    expect(again.service.handoffs({ projectId: 'p_bob' }).incoming).toEqual([])
  })

  it('keeps the sender’s offer across a restart', async () => {
    const { alice } = await team()
    alice.service.offerHandoff({ worktree: AUTH, to: 'bob', note: 'x' })
    await alice.service.flushHandoffs()
    alice.service.stop()

    const { dataDir } = alice
    const restarted = await createPeerRuntime({
      dial: createFakeRelay().dial,
      scheduler: createManualScheduler(),
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      runner: fixedRemoteRunner(ORIGIN),
      dataDir,
      workspace: alice.workspace
    })
    await restarted.service.start()
    cleanups.push(() => restarted.service.stop())
    expect(restarted.service.handoffs({ projectId: 'p_alice' }).outgoing).toMatchObject([{ to: 'bob' }])
  })

  it('replaces an untaken offer of the same worktree rather than stacking them', async () => {
    const { alice } = await team()
    alice.service.offerHandoff({ worktree: AUTH, to: 'bob', note: 'first' })
    alice.service.offerHandoff({ worktree: AUTH, to: 'carol', note: 'second' })
    expect(alice.service.handoffs({ projectId: 'p_alice' }).outgoing.map((held) => held.to)).toEqual(['carol'])
  })
})

describe('a handoff as it arrives', () => {
  const snapshot = (extras: Record<string, unknown>) => ({ revision: 1, handle: 'alice', projects: [], ...extras })
  const handoff = { id: 'h1', to: 'bob', worktreeName: 'auth', branch: 'auth', note: 'finish it', at: 1 }

  it('keeps at most the bound, and drops an oversized note’s whole list rather than the snapshot', () => {
    const many = Array.from({ length: MAX_HANDOFFS + 5 }, (_, index) => ({ ...handoff, id: `h${index}` }))
    expect(parsePeerPresence(snapshot({ handoffs: many }), PROJECT_KEY)?.handoffs).toHaveLength(MAX_HANDOFFS)

    const huge = { ...handoff, note: 'x'.repeat(MAX_HANDOFF_NOTE_CHARS + 1) }
    const read = parsePeerPresence(snapshot({ handoffs: [huge], took: ['h0'] }), PROJECT_KEY)
    expect(read?.handoffs).toBeUndefined()
    expect(read?.took).toEqual(['h0'])
  })

  it('reads a snapshot from a build with no handoffs unchanged', () => {
    expect(parsePeerPresence(snapshot({}), PROJECT_KEY)).toEqual(snapshot({}))
  })
})
