// Sharing a note: the inbox's bounds and file, the roster check on arrival, and two runtimes over a relay
// proving a note Alice shares is waiting for Bob, and still there after Bob restarts.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SHARED_NOTE_BYTES, type SharedNoteSummary } from '../../../shared/sharedNote'
import { ErrorCode } from '../../../shared/protocol'
import { loadIdentity } from '../identity'
import { MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS } from '../memberFile'
import {
  createNoteInbox,
  MAX_HELD_BYTES,
  MAX_HELD_NOTES,
  MAX_UNSEEN_PER_SENDER,
  NOTES_DIR,
  type ArrivingNote
} from './noteInbox'
import { linkIdFor } from './peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  worktree,
  type PeerRuntime
} from './peerTestSupport'
import { normaliseRemote, projectKeyFor } from './projectKey'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN = 'git@example.invalid:team/repo.git'
const PROJECT_KEY = projectKeyFor(normaliseRemote(ORIGIN) as string)
const PLAN = { noteId: 'NOTES.md', title: 'Plan', markdown: '# Plan\n\n- ship it\n' }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const arriving = (publicKey: string, title = 'Plan', over: Partial<ArrivingNote> = {}): ArrivingNote => ({
  projectId: 'p_a',
  handle: publicKey,
  publicKey,
  noteId: 'NOTES.md',
  title,
  markdown: 'body',
  sentAt: 1,
  ...over
})

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'teamree-notes-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('the inbox', () => {
  it('keeps notes oldest first, without their bodies, until one is opened', () => {
    let clock = 100
    const inbox = createNoteInbox({ now: () => clock++ })
    const first = inbox.add(arriving('ana', 'one'))
    inbox.add(arriving('bo', 'two'))

    expect(inbox.list().map((note) => [note.title, note.seen])).toEqual([
      ['one', false],
      ['two', false]
    ])
    expect(inbox.list()[0]).not.toHaveProperty('markdown')

    expect(inbox.view(first.shareId)?.markdown).toBe('body')
    expect(inbox.list().map((note) => note.seen)).toEqual([true, false])
    expect(inbox.close(first.shareId)).toBe(true)
    expect(inbox.view(first.shareId)).toBeUndefined()
  })

  it('refuses a sender with too many unread notes waiting, and nobody else', () => {
    const inbox = createNoteInbox({ now: () => 0 })
    for (let index = 0; index < MAX_UNSEEN_PER_SENDER; index += 1) inbox.add(arriving('ana'))
    expect(() => inbox.add(arriving('ana'))).toThrow(/unread/)
    expect(() => inbox.add(arriving('bo'))).not.toThrow()
  })

  it('makes room by forgetting the oldest seen note, never an unseen one', () => {
    const inbox = createNoteInbox({ now: () => 0 })
    const senders = Array.from({ length: MAX_HELD_NOTES }, (_, index) => `key${index}`)
    const held = senders.map((key) => inbox.add(arriving(key, key)))
    expect(() => inbox.add(arriving('late'))).toThrow(/too many unread/)

    inbox.view(held[3]?.shareId ?? '')
    inbox.add(arriving('late', 'late'))
    const titles = inbox.list().map((note) => note.title)
    expect(titles).toHaveLength(MAX_HELD_NOTES)
    expect(titles).not.toContain('key3')
    expect(titles.at(-1)).toBe('late')
  })

  it('counts its bounds per project', () => {
    const inbox = createNoteInbox({ now: () => 0 })
    for (let index = 0; index < MAX_HELD_NOTES; index += 1) inbox.add(arriving(`key${index}`))
    expect(() => inbox.add(arriving('late', 'late', { projectId: 'p_b' }))).not.toThrow()
  })

  it('makes room by bytes as well as by count', () => {
    const inbox = createNoteInbox({ now: () => 0 })
    const big = 'x'.repeat(200 * 1024)
    const fits = Math.floor(MAX_HELD_BYTES / (200 * 1024))
    const held = Array.from({ length: fits }, (_, index) =>
      inbox.add(arriving(`key${index}`, `n${index}`, { markdown: big }))
    )
    expect(() => inbox.add(arriving('late', 'late', { markdown: big }))).toThrow(/too many unread/)

    inbox.dismiss(held[0]?.shareId ?? '')
    inbox.add(arriving('late', 'late', { markdown: big }))
    expect(inbox.list().map((note) => note.title)).not.toContain('n0')
  })

  it('dismisses without forgetting: the popup retires and the note stays unread', () => {
    const inbox = createNoteInbox({ now: () => 0 })
    const note = inbox.add(arriving('ana'))
    expect(inbox.dismiss(note.shareId)).toBe(true)
    expect(inbox.list()).toMatchObject([{ shareId: note.shareId, seen: true }])
    expect(inbox.list()[0]?.read).toBeFalsy()

    inbox.view(note.shareId)
    expect(inbox.list()[0]?.read).toBe(true)
    expect(inbox.dismiss('nope')).toBe(false)
  })

  it('keeps what it holds in a file per project, and reads it back', async () => {
    const dir = await scratchDir()
    let clock = 100
    const first = createNoteInbox({ now: () => clock++, dir })
    const kept = first.add(arriving('ana', 'one'))
    first.add(arriving('bo', 'two', { projectId: 'p_b' }))
    const gone = first.add(arriving('cy', 'three'))
    first.dismiss(kept.shareId)
    first.close(gone.shareId)
    await first.flush()
    expect((await readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(2)

    const second = createNoteInbox({ now: () => clock++, dir })
    await second.load()
    expect(second.list().map((note) => [note.projectId, note.title, note.seen])).toEqual([
      ['p_a', 'one', true],
      ['p_b', 'two', false]
    ])
    expect(second.view(kept.shareId)?.markdown).toBe('body')
  })

  it('removes a project’s file once its last note goes', async () => {
    const dir = await scratchDir()
    const inbox = createNoteInbox({ now: () => 0, dir })
    const note = inbox.add(arriving('ana'))
    await inbox.flush()
    inbox.close(note.shareId)
    await inbox.flush()
    expect(await readdir(dir)).toEqual([])
  })

  it('sets an unreadable file aside and starts empty', async () => {
    const dir = await scratchDir()
    await writeFile(join(dir, 'bad.json'), '{ not json')
    const inbox = createNoteInbox({ now: () => 0, dir })
    await inbox.load()
    expect(inbox.list()).toEqual([])
    expect(await readdir(dir)).toEqual(['bad.json.unreadable'])
  })
})

type Owner = { runtime: PeerRuntime; dir: string; aliceKey: string; linkId: string; noted: SharedNoteSummary[] }

/** This machine, with Alice on the project's roster. Nothing connects: arrivals are driven by the link id. */
async function owner(): Promise<Owner> {
  const aliceKey = (await loadIdentity(await mkdtemp(join(tmpdir(), 'teamree-alice-')))).publicKey
  const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
  const ownerKey = (await loadIdentity(ownerData)).publicKey
  const dir = await makeProjectDir([
    { handle: 'owner', publicKey: ownerKey },
    { handle: 'alice', publicKey: aliceKey }
  ])
  const scheduler = createManualScheduler()
  const noted: SharedNoteSummary[] = []
  const runtime = await createPeerRuntime({
    dial: createFakeRelay().dial,
    scheduler,
    env: { TEAMREE_RELAY_URL: RELAY_URL },
    dataDir: ownerData,
    runner: fixedRemoteRunner(ORIGIN),
    onNote: (note) => noted.push(note),
    workspace: { projects: [project('p_a', dir)], worktrees: [worktree('wt_a', 'p_a', 'a', 'main')], terminals: [] }
  })
  await runtime.service.start()
  await scheduler.advance(0)
  cleanups.push(() => runtime.service.stop())
  return { runtime, dir, aliceKey, linkId: linkIdFor(aliceKey, PROJECT_KEY), noted }
}

const arrive = (runtime: PeerRuntime, connectionId: string, params: unknown) =>
  runtime.dispatch({ id: 'n', method: 'peer.shareNote', params }, { connectionId })

describe('a note arriving', () => {
  it('is filed under the name this project’s roster gives the key that sent it', async () => {
    const { runtime, linkId, noted } = await owner()
    const answer = await arrive(runtime, linkId, { ...PLAN, sentAt: 5 })

    expect(answer).toMatchObject({ ok: true, result: { received: true } })
    expect(runtime.service.sharedNotes()).toMatchObject([
      { projectId: 'p_a', handle: 'alice', title: 'Plan', noteId: 'NOTES.md', sentAt: 5, seen: false }
    ])
    expect(noted.map((note) => note.handle)).toEqual(['alice'])
  })

  it('is refused from a connection that is no teammate’s link', async () => {
    const { runtime, noted } = await owner()
    const answer = await arrive(runtime, 'window-1', { ...PLAN, sentAt: 5 })

    expect(answer).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
    expect(runtime.service.sharedNotes()).toEqual([])
    expect(noted).toEqual([])
  })

  it('is refused when it is not a note, and nothing is filed', async () => {
    const { runtime, linkId } = await owner()
    for (const params of [
      { ...PLAN, title: '' },
      { ...PLAN, sentAt: 'now' },
      { ...PLAN, markdown: 'x'.repeat(MAX_SHARED_NOTE_BYTES), sentAt: 5 }
    ]) {
      expect(await arrive(runtime, linkId, params)).toMatchObject({
        ok: false,
        error: { code: ErrorCode.InvalidParams }
      })
    }
    expect(runtime.service.sharedNotes()).toEqual([])
  })

  it('is refused once the sender leaves the roster, and what they sent before goes with them', async () => {
    const { runtime, dir, linkId } = await owner()
    await arrive(runtime, linkId, { ...PLAN, sentAt: 5 })
    expect(runtime.service.sharedNotes()).toHaveLength(1)

    await rm(join(dir, ...MEMBERS_DIR_SEGMENTS, `alice${MEMBER_FILE_SUFFIX}`))
    await runtime.service.reconcile()

    expect(runtime.service.sharedNotes()).toEqual([])
    expect(await arrive(runtime, linkId, { ...PLAN, sentAt: 6 })).toMatchObject({ ok: false })
    expect(runtime.service.sharedNotes()).toEqual([])
  })

  it('stays when the roster cannot be read, rather than going with it', async () => {
    const { runtime, dir, linkId } = await owner()
    await arrive(runtime, linkId, { ...PLAN, sentAt: 5 })

    await rm(join(dir, ...MEMBERS_DIR_SEGMENTS), { recursive: true })
    await writeFile(join(dir, ...MEMBERS_DIR_SEGMENTS), 'not a folder')
    await runtime.service.reconcile()

    expect(runtime.service.sharedNotes()).toHaveLength(1)
  })

  it('is kept when dismissed, and forgotten only when closed', async () => {
    const { runtime, linkId } = await owner()
    await arrive(runtime, linkId, { ...PLAN, sentAt: 5 })
    const [summary] = runtime.service.sharedNotes()
    const shareId = summary?.shareId ?? ''

    expect(runtime.service.dismissNote({ shareId })).toEqual({ dismissed: true })
    expect(runtime.service.sharedNotes()).toMatchObject([{ shareId, seen: true }])
    expect(runtime.service.viewNote({ shareId }).markdown).toBe(PLAN.markdown)
  })

  it('is read whole once, then forgotten when closed', async () => {
    const { runtime, linkId } = await owner()
    await arrive(runtime, linkId, { ...PLAN, sentAt: 5 })
    const [summary] = runtime.service.sharedNotes()

    expect(runtime.service.viewNote({ shareId: summary?.shareId ?? '' }).markdown).toBe(PLAN.markdown)
    expect(runtime.service.sharedNotes()[0]?.seen).toBe(true)
    expect(runtime.service.closeNote({ shareId: summary?.shareId ?? '' })).toEqual({ closed: true })
    expect(() => runtime.service.viewNote({ shareId: summary?.shareId ?? '' })).toThrow()
  })
})

describe('two peers over a relay', () => {
  /** Alice and Bob on one relay, both on each other's roster; Carol is on it too and never comes online. */
  async function pair() {
    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const aliceData = await mkdtemp(join(tmpdir(), 'teamree-alice-'))
    const bobData = await mkdtemp(join(tmpdir(), 'teamree-bob-'))
    const [aliceKey, bobKey, carolKey] = [
      (await loadIdentity(aliceData)).publicKey,
      (await loadIdentity(bobData)).publicKey,
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
    const bobNoted: SharedNoteSummary[] = []
    const alice = await createPeerRuntime({
      ...shared,
      dataDir: aliceData,
      workspace: {
        projects: [project('p_alice', await makeProjectDir(roster))],
        worktrees: [worktree('wt_a', 'p_alice', 'a', 'main')],
        terminals: []
      }
    })
    const bobWorkspace = {
      projects: [project('p_bob', await makeProjectDir(roster))],
      worktrees: [worktree('wt_b', 'p_bob', 'b', 'main')],
      terminals: []
    }
    const startBob = async (): Promise<PeerRuntime> => {
      const bob = await createPeerRuntime({
        ...shared,
        dataDir: bobData,
        onNote: (note) => bobNoted.push(note),
        workspace: bobWorkspace
      })
      await bob.service.start()
      cleanups.push(() => bob.service.stop())
      return bob
    }
    await alice.service.start()
    cleanups.push(() => alice.service.stop())
    const bob = await startBob()
    await scheduler.advance(0)
    return { alice, bob, scheduler, bobNoted, startBob, bobData }
  }

  it('A shares a note and B has it waiting, with its window and its notifications told', async () => {
    const { alice, bob, scheduler, bobNoted } = await pair()
    const changesBefore = bob.changes()

    const sending = alice.dispatch(
      { id: 's', method: 'teamwork.shareNote', params: { projectId: 'p_alice', ...PLAN } },
      { connectionId: 'window' }
    )
    await scheduler.advance(0)
    const answer = await sending

    expect(answer).toMatchObject({
      ok: true,
      result: { projectId: 'p_alice', delivered: ['bob'], missed: [{ handle: 'carol', reason: 'offline' }] }
    })
    expect(bob.service.sharedNotes()).toMatchObject([
      { projectId: 'p_bob', handle: 'alice', title: 'Plan', noteId: 'NOTES.md', seen: false }
    ])
    expect(bobNoted.map((note) => `${note.handle} shared ${note.title}`)).toEqual(['alice shared Plan'])
    expect(bob.changes()).toBeGreaterThan(changesBefore)

    const [summary] = bob.service.sharedNotes()
    expect(bob.service.viewNote({ shareId: summary?.shareId ?? '' }).markdown).toBe(PLAN.markdown)
    expect(alice.service.sharedNotes()).toEqual([])
  })

  it('B still has the note after a restart, as B left it', async () => {
    const { alice, bob, scheduler, startBob, bobData } = await pair()
    const sending = alice.service.shareNote({ projectId: 'p_alice', ...PLAN })
    await scheduler.advance(0)
    expect(await sending).toMatchObject({ delivered: ['bob'] })
    const [summary] = bob.service.sharedNotes()
    bob.service.dismissNote({ shareId: summary?.shareId ?? '' })
    await bob.service.stop()
    expect(await readdir(join(bobData, NOTES_DIR))).toHaveLength(1)

    const again = await startBob()
    await scheduler.advance(0)
    expect(again.service.sharedNotes()).toMatchObject([
      { shareId: summary?.shareId, projectId: 'p_bob', handle: 'alice', title: 'Plan', seen: true }
    ])
    expect(again.service.viewNote({ shareId: summary?.shareId ?? '' }).markdown).toBe(PLAN.markdown)
  })

  it('refuses a note over the cap before anything leaves this machine', async () => {
    const { alice, bob, scheduler } = await pair()
    const sending = alice.dispatch(
      {
        id: 's',
        method: 'teamwork.shareNote',
        params: { projectId: 'p_alice', ...PLAN, markdown: 'x'.repeat(MAX_SHARED_NOTE_BYTES) }
      },
      { connectionId: 'window' }
    )
    await scheduler.advance(0)

    expect(await sending).toMatchObject({ ok: false, error: { code: ErrorCode.InvalidParams } })
    expect(bob.service.sharedNotes()).toEqual([])
  })

  it('says so when nobody on the project is online to receive it', async () => {
    const { alice, bob, scheduler } = await pair()
    bob.service.stop()
    await scheduler.advance(0)

    const sending = alice.service.shareNote({ projectId: 'p_alice', ...PLAN })
    await scheduler.advance(0)
    expect(await sending).toEqual({
      projectId: 'p_alice',
      delivered: [],
      missed: [
        { handle: 'bob', reason: 'offline' },
        { handle: 'carol', reason: 'offline' }
      ]
    })
  })
})
