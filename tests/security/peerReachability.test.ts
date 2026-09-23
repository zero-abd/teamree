// The flat-refusal invariant for every `PEER_METHODS` entry but `terminal.write` (paneScoping.test.ts):
// asking about something never offered answers exactly as asking about nothing, compared byte for byte
// because the property is sameness, not wording. The last test records where the promise is narrower.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadIdentity } from '../../src/main/teamwork/identity'
import { MEMBERS_DIR_SEGMENTS, MEMBER_FILE_SUFFIX } from '../../src/main/teamwork/memberFile'
import { linkIdFor } from '../../src/main/teamwork/peer/peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  makeProjectDir,
  project,
  remoteRunner,
  terminal,
  worktree,
  type PeerRuntime
} from '../../src/main/teamwork/peer/peerTestSupport'
import { normaliseRemote, projectKeyFor } from '../../src/main/teamwork/peer/projectKey'
import { ErrorCode } from '../../src/shared/protocol'
import { generateStaticKeyPair } from '../../src/shared/peer'
import { ownerRig, refusalsOf, settle } from './peerRig'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN_OPEN = 'git@example.invalid:team/open.git'
const ORIGIN_SECRET = 'git@example.invalid:team/secret.git'
const ORIGIN_OTHER = 'git@example.invalid:team/other.git'
const KEY_OPEN = projectKeyFor(normaliseRemote(ORIGIN_OPEN) as string)
const KEY_SECRET = projectKeyFor(normaliseRemote(ORIGIN_SECRET) as string)
const KEY_OTHER = projectKeyFor(normaliseRemote(ORIGIN_OTHER) as string)

/**
 * Alice in three repositories, Mallory on two rosters. `p_other` is the one Mallory IS on under a
 * different project key: without it the project-key narrowing could be deleted with nothing going red.
 */
async function threeProjects() {
  const scheduler = createManualScheduler()
  const relay = createFakeRelay()
  const mallory = Buffer.from(generateStaticKeyPair().publicKey).toString('base64')
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-sec-reach-'))
  const { publicKey: aliceKey } = await loadIdentity(dataDir)

  const openPath = await makeProjectDir([
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'mallory', publicKey: mallory }
  ])
  const secretPath = await makeProjectDir([{ handle: 'alice', publicKey: aliceKey }])
  const otherPath = await makeProjectDir([
    { handle: 'alice', publicKey: aliceKey },
    { handle: 'mallory', publicKey: mallory }
  ])

  const alice = await createPeerRuntime({
    dial: relay.dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    runner: remoteRunner({ [openPath]: ORIGIN_OPEN, [secretPath]: ORIGIN_SECRET, [otherPath]: ORIGIN_OTHER }),
    dataDir,
    workspace: {
      projects: [project('p_open', openPath), project('p_secret', secretPath), project('p_other', otherPath)],
      worktrees: [
        worktree('wt_open', 'p_open', 'shared', 'feat/shared'),
        worktree('wt_secret', 'p_secret', 'private', 'feat/private'),
        worktree('wt_other', 'p_other', 'elsewhere', 'feat/elsewhere')
      ],
      terminals: [
        terminal('t_open', 'wt_open', { running: true }),
        terminal('t_secret', 'wt_secret', { running: true }),
        terminal('t_other', 'wt_other', { running: true })
      ]
    }
  })
  await alice.service.start()

  return {
    alice,
    openPath,
    /** The connection id Mallory's session for the shared repository answers on. */
    shared: linkIdFor(mallory, KEY_OPEN),
    /** A session for the repository she has no key for, if she could ever get one. */
    forged: linkIdFor(mallory, KEY_SECRET),
    /** Her real session for the third repository, which this one must never carry. */
    elsewhere: linkIdFor(mallory, KEY_OTHER)
  }
}

/** A thrown refusal in the shape the two sides of a comparison can be equal in. */
function thrownBy(run: () => unknown): { code: unknown; message: string } {
  try {
    run()
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: (error as Error).message }
  }
  throw new Error('nothing was thrown, and the refusal is what was under test')
}

const presenceOf = (runtime: PeerRuntime, connectionId: string) => runtime.service.peerPresence(connectionId)

describe('terminal.read and terminal.subscribe, which name a pane', () => {
  it('answers a pane of a repository they hold no key for exactly as one that never existed', async () => {
    const { alice, shared } = await threeProjects()

    // `t_secret` is real, `t_nothing` never was; the answers differ only in the id the caller chose.
    const theirs = alice.service.remoteRead(shared, 't_secret')
    const invented = alice.service.remoteRead(shared, 't_nothing')

    expect(theirs).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no pane t_secret in this project'
    })
    expect(invented).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no pane t_nothing in this project'
    })
    // Said as sameness as well as text: the property is that the two cannot be told apart.
    expect({ ...theirs, message: '' }).toEqual({ ...invented, message: '' })
  })

  it('does not make a pane that has closed an oracle for a pane of another project', async () => {
    const { alice, shared } = await threeProjects()
    // Read once so this machine remembers having offered it, then closed under the watcher.
    expect(alice.service.remoteRead(shared, 't_open').ok).toBe(true)
    alice.workspace.terminals = alice.workspace.terminals.filter((pane) => pane.id !== 't_open')

    // The closed pane gets the one kinder sentence; everything never offered keeps the flat one,
    // which stops the kinder sentence being a way to ask "did this id ever name a pane".
    expect(alice.service.remoteRead(shared, 't_open')).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'the owner closed this pane'
    })
    expect(alice.service.remoteRead(shared, 't_secret')).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no pane t_secret in this project'
    })
  })
})

describe('peer.presence and peer.subscribe, which name nothing', () => {
  it('carries only the repository the session is for, never the others open beside it', async () => {
    const { alice, shared, elsewhere } = await threeProjects()
    const presence = presenceOf(alice, shared)

    expect(presence.projects.map((entry) => entry.projectKey)).toEqual([KEY_OPEN])
    // The only method answering with a list, so what it leaves out is its whole scoping; `p_other`
    // is the half that matters, since only the project key keeps it out.
    const wire = JSON.stringify(presence)
    for (const withheld of [
      'wt_secret',
      't_secret',
      'feat/private',
      KEY_SECRET,
      'wt_other',
      't_other',
      'feat/elsewhere',
      KEY_OTHER
    ]) {
      expect(wire).not.toContain(withheld)
    }
    // And the other way round: the narrowing is about which link asked, not about hiding anything.
    expect(presenceOf(alice, elsewhere).projects.map((entry) => entry.projectKey)).toEqual([KEY_OTHER])
  })

  it('answers a session claiming the other repository’s key exactly as a connection that was never a link', async () => {
    const { alice, forged } = await threeProjects()

    // `peer.subscribe` resolves a snapshot before opening a stream, so both link-scoped reads share this.
    expect(thrownBy(() => presenceOf(alice, forged))).toEqual(thrownBy(() => presenceOf(alice, 'peer_nobody_nothing')))
    expect(thrownBy(() => presenceOf(alice, forged)).code).toBe(ErrorCode.NotFound)
  })

  it('stops carrying the project the moment the key leaves the roster', async () => {
    const { alice, openPath, shared } = await threeProjects()
    expect(presenceOf(alice, shared).projects).toHaveLength(1)

    await rm(join(openPath, ...MEMBERS_DIR_SEGMENTS, `mallory${MEMBER_FILE_SUFFIX}`))
    await alice.service.reconcile()

    // The link is gone with the roster entry, so this is the flat refusal, not an empty snapshot.
    expect(thrownBy(() => presenceOf(alice, shared))).toEqual(thrownBy(() => presenceOf(alice, 'peer_nobody_nothing')))
  })
})

describe('unsubscribe, which names a stream', () => {
  it('cannot end a stream another teammate opened, and is told what an invented id is told', async () => {
    const { alice } = await threeProjects()
    const events: unknown[] = []
    alice.subscriptions.openConnection('peer_bo', (frame) => events.push(frame))
    alice.subscriptions.openConnection('peer_mallory', () => {})
    const bos = alice.subscriptions.subscribe('peer_bo', (channel) => {
      queueMicrotask(() => channel.emit({ type: 'data', data: 'still here' }))
      return () => {}
    })

    const ending = (connectionId: string, subscription: string) =>
      alice.dispatch({ id: 'u', method: 'unsubscribe', params: { subscription } }, { connectionId })

    // Scoped to the calling connection in `unsubscribeHandler.ts`: stream ids come from a counter,
    // so guessing one is a matter of counting.
    const stolen = await ending('peer_mallory', bos)
    const invented = await ending('peer_mallory', 'sub_99999')
    expect(stolen).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
    expect({ ...stolen, error: { ...(stolen as { error: object }).error, message: '' } }).toEqual({
      ...invented,
      error: { ...(invented as { error: object }).error, message: '' }
    })

    // And the stream is still a stream: torn down anyway would be the same breach, politer.
    await settle()
    expect(events).toEqual([{ stream: bos, event: { type: 'data', data: 'still here' } }])
    expect(alice.subscriptions.countFor('peer_bo')).toBe(1)
  })
})

describe('a method that is not a teammate’s to call', () => {
  it('answers exactly as a method nobody ever wrote', async () => {
    const owner = ownerRig()
    // `worktree.remove` is registered but off the allow-list; `not.a.method` is nothing. Same answer,
    // or the catalogue is enumerable from the far end of a relay by reading which refusals differ.
    owner.sendRaw([
      JSON.stringify({ id: 'a', method: 'worktree.remove', params: { worktreeId: 'wt_1' } }),
      JSON.stringify({ id: 'b', method: 'not.a.method', params: {} })
    ])
    await settle()

    const [off, absent] = refusalsOf(owner.replies())
    expect(off?.code).toBe(ErrorCode.UnknownMethod)
    expect(off?.message).toBe('worktree.remove is not a method a teammate can call')
    expect(absent?.message).toBe('not.a.method is not a method a teammate can call')
    // Refused in front of the dispatcher, so it cannot be timed apart from one that does not exist.
    expect(owner.dispatched()).toBe(0)
  })
})

describe('what the owner is shown about who is reading', () => {
  it('names a teammate who opened a stream on a pane', async () => {
    const owner = ownerRig()
    owner.sendRaw([JSON.stringify({ id: 's', method: 'terminal.subscribe', params: { terminalId: 't_1' } })])
    await settle()

    expect(owner.watched()).toEqual(['t_1'])
  })

  it('says nothing about a teammate who only reads the scrollback, which is the limit of the promise', async () => {
    const owner = ownerRig()
    // Reading is not gated and a one-shot read is not a stream, so a poller is not on the row.
    // Recorded so changing it is a decision rather than something that quietly stops being true.
    for (let n = 0; n < 10; n += 1) {
      owner.sendRaw([JSON.stringify({ id: `r${n}`, method: 'terminal.read', params: { terminalId: 't_1' } })])
    }
    await settle()

    expect(owner.reads()).toHaveLength(10)
    expect(refusalsOf(owner.replies())).toEqual([])
    expect(owner.watched()).toEqual([])
  })
})
