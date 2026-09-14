// The flat-refusal invariant, asserted once for every method a teammate can
// call rather than once for the two that happened to have tests.
//
// `PEER_METHODS` admits six things: `peer.presence`, `peer.subscribe`,
// `unsubscribe`, `terminal.read`, `terminal.subscribe` and `terminal.write`.
// `docs/teamwork.md` promises that none of them is an oracle — that asking
// about something a teammate was never offered answers exactly as asking about
// something that does not exist, so a refusal cannot be used to map the panes,
// the projects or the streams on somebody else's machine. `paneScoping.test.ts`
// holds that for `terminal.write`. This file holds it for the rest, and it is
// written as byte-for-byte comparisons rather than as message assertions
// because the property is sameness and not wording: a sentence someone improves
// on one path and not the other is exactly how this stops being true.
//
// The last test in here is not a refusal at all. It is the one place the
// promise in that document is narrower than the sentence, and it is written
// down so the narrowness is a fact on the record rather than a surprise: a
// teammate who reads a pane's scrollback without opening a stream on it is not
// reported to the owner as watching it, because nothing about a one-shot read
// outlives the answer. Reading was never gated — the document says so twice —
// but "a pane being watched says so, and by whom" is a statement about streams,
// and the test says which.
//
// Nothing here is an exploit. It is the record of what was probed and held.

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
 * Alice, in three repositories, with Mallory on two of the three rosters.
 *
 * `paneScoping.test.ts` builds the first two: `p_open` is shared and `p_secret`
 * is a repository Mallory holds no key for. `p_other` is the third and it is
 * here for one reason — it is a repository Mallory IS on the roster of, under a
 * different origin and therefore a different project key.
 *
 * Without it, every scoping assertion below would pass on the roster filter
 * alone and the project-key narrowing beside it could be deleted with nothing
 * going red. Membership and project are two separate facts, `docs/teamwork.md`
 * turns on both, and only a teammate who has one and not the other can tell
 * which of them is doing the work.
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

    // `t_secret` is a real pane of a real project, open in this very runtime.
    // `t_nothing` has never been anything. The answers differ in nothing but
    // the id the caller itself chose, which it already knew.
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
    // Said as sameness as well as as text, because the property is that the two
    // cannot be told apart and not that either of them reads well.
    expect({ ...theirs, message: '' }).toEqual({ ...invented, message: '' })
  })

  it('does not make a pane that has closed an oracle for a pane of another project', async () => {
    const { alice, shared } = await threeProjects()
    // A pane of the shared project, read once so this machine remembers having
    // offered it, then closed out from under the watcher.
    expect(alice.service.remoteRead(shared, 't_open').ok).toBe(true)
    alice.workspace.terminals = alice.workspace.terminals.filter((pane) => pane.id !== 't_open')

    // The closed pane gets the one sentence that is not the flat refusal — a
    // watcher who was reading it a moment ago must not be told it was never
    // theirs to see. Everything Mallory was never offered keeps the flat one,
    // which is what stops that kinder sentence being a way to ask "did this id
    // ever name a pane on your machine".
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
    // Not a branch name, a worktree name or a pane id of either of the other
    // two, anywhere in the snapshot. This is the only method a teammate can
    // call that answers with a list rather than about a thing they named, so
    // what it leaves out is the whole of its scoping — and `p_other` is the
    // half that matters, because Mallory is genuinely on that roster and the
    // only thing keeping it out of this answer is the project key.
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
    // Said the other way round as well: her session for that third repository
    // is a real session and carries that repository, so the narrowing above is
    // about which link asked and not about anything being hidden from her.
    expect(presenceOf(alice, elsewhere).projects.map((entry) => entry.projectKey)).toEqual([KEY_OTHER])
  })

  it('answers a session claiming the other repository’s key exactly as a connection that was never a link', async () => {
    const { alice, forged } = await threeProjects()

    // `peer.subscribe` resolves a snapshot before it opens a stream, so this is
    // the refusal both of the link-scoped reads are built on.
    expect(thrownBy(() => presenceOf(alice, forged))).toEqual(thrownBy(() => presenceOf(alice, 'peer_nobody_nothing')))
    expect(thrownBy(() => presenceOf(alice, forged)).code).toBe(ErrorCode.NotFound)
  })

  it('stops carrying the project the moment the key leaves the roster', async () => {
    const { alice, openPath, shared } = await threeProjects()
    expect(presenceOf(alice, shared).projects).toHaveLength(1)

    await rm(join(openPath, ...MEMBERS_DIR_SEGMENTS, `mallory${MEMBER_FILE_SUFFIX}`))
    await alice.service.reconcile()

    // Revocation is what the roster is for, and it has to reach the one method
    // that hands over a list without being asked about anything in particular.
    // The link is gone with the roster entry, so this is the flat refusal
    // again rather than an empty snapshot.
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

    // Scoped to the calling connection in `unsubscribeHandler.ts`, which is the
    // only thing standing between one teammate's link and every stream on the
    // machine: the ids are minted by a counter the hub owns, so guessing one is
    // a matter of counting rather than of knowing anything.
    const stolen = await ending('peer_mallory', bos)
    const invented = await ending('peer_mallory', 'sub_99999')
    expect(stolen).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
    expect({ ...stolen, error: { ...(stolen as { error: object }).error, message: '' } }).toEqual({
      ...invented,
      error: { ...(invented as { error: object }).error, message: '' }
    })

    // And the stream is still a stream: a refusal that had torn it down anyway
    // would be the same breach with a politer answer.
    await settle()
    expect(events).toEqual([{ stream: bos, event: { type: 'data', data: 'still here' } }])
    expect(alice.subscriptions.countFor('peer_bo')).toBe(1)
  })
})

describe('a method that is not a teammate’s to call', () => {
  it('answers exactly as a method nobody ever wrote', async () => {
    const owner = ownerRig()
    // `worktree.remove` is registered, reachable over IPC and over the CLI
    // socket, and off the allow-list. `not.a.method` is nothing at all. From
    // where the teammate stands those are the same fact, and the answer says so
    // — otherwise the catalogue is enumerable from the far end of a relay by
    // asking for everything and reading which refusals differ.
    owner.sendRaw([
      JSON.stringify({ id: 'a', method: 'worktree.remove', params: { worktreeId: 'wt_1' } }),
      JSON.stringify({ id: 'b', method: 'not.a.method', params: {} })
    ])
    await settle()

    const [off, absent] = refusalsOf(owner.replies())
    expect(off?.code).toBe(ErrorCode.UnknownMethod)
    expect(off?.message).toBe('worktree.remove is not a method a teammate can call')
    expect(absent?.message).toBe('not.a.method is not a method a teammate can call')
    // Refused in front of the dispatcher, so a method off the list costs the
    // owner's main thread nothing and cannot be timed apart from one that does
    // not exist either.
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
    // Ten reads of the same pane. Every one of them is answered — reading is
    // not gated and `docs/teamwork.md` says so — and not one of them is a
    // stream, so nothing outlives the answer for the owner's panel to draw.
    // This is the honest edge of "a pane being watched says so, and by whom":
    // it is about streams, and a caller that polls instead of subscribing is
    // not on the row. Recorded here so that changing it is a decision somebody
    // makes rather than something that quietly stops being true.
    for (let n = 0; n < 10; n += 1) {
      owner.sendRaw([JSON.stringify({ id: `r${n}`, method: 'terminal.read', params: { terminalId: 't_1' } })])
    }
    await settle()

    expect(owner.reads()).toHaveLength(10)
    expect(refusalsOf(owner.replies())).toEqual([])
    expect(owner.watched()).toEqual([])
  })
})
