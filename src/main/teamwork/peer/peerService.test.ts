// The owner's half of "anyone on the roster can type here", asserted against
// the real judge rather than against a stand-in for it.
//
// `docs/teamwork.md` names attribution and an instant mute as the whole of what
// makes a pane anyone may type into survivable. Both of those are answered
// here, by `remoteWrite`, `remoteRead`, `watchers` and `teamwork.writeLog`, and
// every test in this file is about one of them being true of the project the
// message actually arrived on — not of some other project the same key happens
// to appear in.
//
// Nothing here goes near a relay: a verdict is a synchronous answer about this
// machine's own rosters and panes, and driving it directly is what lets two
// projects be in play at once without two of everything else.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PaneTypist, RemoteWrite, Terminal } from '../../../shared/entities'
import { ErrorCode } from '../../../shared/protocol'
import { canSpawnPty } from '../../terminals/pty-test-support'
import { MEMBERS_DIR_SEGMENTS } from '../memberFile'
import { loadIdentity } from '../identity'
import { linkIdFor, PeerService } from './peerService'
import {
  createFakeRelay,
  createManualScheduler,
  createPeerRuntime,
  decided,
  makeProjectDir,
  project,
  remoteRunner,
  standingConsent,
  presenceOf,
  statusOf,
  terminal,
  worktree,
  type PeerRuntime
} from './peerTestSupport'
import { normaliseRemote, projectKeyFor } from './projectKey'
import { SubscriptionHub } from '../../runtime/subscriptionHub'

const RELAY_URL = 'ws://relay.invalid/v1/relay'
const ORIGIN_A = 'git@github.com:team/repo.git'
const ORIGIN_Z = 'git@github.com:team/other.git'
const KEY_A = projectKeyFor(normaliseRemote(ORIGIN_A) ?? '')

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A pane of this machine, in the worktree each of these tests gives a project. */
function pane(projectId: string, id: string, overrides: Partial<Terminal> = {}): Terminal {
  return terminal(id, `wt_${projectId}`, overrides)
}

const typistsOn = (runtime: PeerRuntime, projectId: string, terminalId: string): PaneTypist[] =>
  runtime.service.watchers({ projectId }).panes.find((row) => row.terminalId === terminalId)?.typists ?? []

const logOf = async (runtime: PeerRuntime): Promise<RemoteWrite[]> => (await runtime.service.writeLog({})).writes

describe('a teammate is named by the roster of the project they reached this machine through', () => {
  /**
   * Mallory is `mallory` on the project she shares with the owner, and `ana` on
   * an unrelated repository she also has push to — a key she committed there
   * herself, or, far more ordinarily, one person whose `git config user.email`
   * differs between two checkouts. Neither project knows about the other.
   */
  const twoRosters = async (): Promise<{ runtime: PeerRuntime; malloryKey: string }> => {
    const malloryData = await mkdtemp(join(tmpdir(), 'teamree-mallory-'))
    const malloryKey = (await loadIdentity(malloryData)).publicKey
    const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const ownerKey = (await loadIdentity(ownerData)).publicKey

    // The unrelated repository is listed first, so "the first project that has
    // this key" is the wrong one and the bug has somewhere to happen.
    const elsewhere = await makeProjectDir([
      { handle: 'owner', publicKey: ownerKey },
      { handle: 'ana', publicKey: malloryKey }
    ])
    const shared = await makeProjectDir([
      { handle: 'owner', publicKey: ownerKey },
      { handle: 'mallory', publicKey: malloryKey }
    ])

    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const runtime = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: ownerData,
      // The owner settled this pane for Mallory some time before: these tests
      // are about which roster names her, not about the prompt, and driving
      // the prompt through first would put the subject of every one of them
      // behind a step belonging to a different test.
      consent: standingConsent([{ terminalId: 't_a1', publicKey: malloryKey }]),
      runner: remoteRunner({ [elsewhere]: ORIGIN_Z, [shared]: ORIGIN_A }),
      workspace: {
        projects: [project('p_z', elsewhere), project('p_a', shared)],
        worktrees: [worktree('wt_p_a', 'p_a', 'p_a', 'main'), worktree('wt_p_z', 'p_z', 'p_z', 'main')],
        terminals: [pane('p_a', 't_a1')]
      }
    })
    await runtime.service.start()
    await scheduler.advance(0)
    cleanups.push(async () => {
      runtime.service.stop()
      await Promise.resolve()
    })
    return { runtime, malloryKey }
  }

  it('calls her what this project’s roster calls her, in the teammate list', async () => {
    const { runtime, malloryKey } = await twoRosters()
    expect(presenceOf(runtime.service, 'p_a').teammates.map((row) => row.handle)).toEqual(['mallory'])
    expect(presenceOf(runtime.service, 'p_z').teammates.map((row) => row.handle)).toEqual(['ana'])
    expect(malloryKey).not.toBe('')
  })

  it('attributes her keystroke to her name on this project, live and in the log', async () => {
    const { runtime, malloryKey } = await twoRosters()
    const verdict = decided(
      runtime.service.remoteWrite(linkIdFor(malloryKey, KEY_A), { terminalId: 't_a1', data: 'ls\n', bytes: 3 })
    )

    expect(verdict.ok).toBe(true)
    expect(typistsOn(runtime, 'p_a', 't_a1').map((row) => row.handle)).toEqual(['mallory'])
    expect((await logOf(runtime)).map((entry) => ({ handle: entry.handle, projectId: entry.projectId }))).toEqual([
      { handle: 'mallory', projectId: 'p_a' }
    ])
  })
})

describe('the same repository checked out twice is one team and two projects', () => {
  /**
   * A main checkout and a review checkout of one repository, added as two
   * projects. They hash to one project key, so there is one link — and the
   * presence snapshot that link carries holds the panes of both.
   */
  const twoClones = async (): Promise<{ runtime: PeerRuntime; aliceKey: string; linkId: string }> => {
    const aliceData = await mkdtemp(join(tmpdir(), 'teamree-alice-'))
    const aliceKey = (await loadIdentity(aliceData)).publicKey
    const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const ownerKey = (await loadIdentity(ownerData)).publicKey
    const roster = [
      { handle: 'owner', publicKey: ownerKey },
      { handle: 'alice', publicKey: aliceKey }
    ]
    const cloneA = await makeProjectDir(roster)
    const cloneB = await makeProjectDir(roster)
    // A third project of the owner's that Alice has no part in at all.
    const private_ = await makeProjectDir([{ handle: 'owner', publicKey: ownerKey }])

    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const runtime = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: ownerData,
      // Both of the owner's own panes are already Alice's to type in, so what
      // these tests exercise is the scoping rather than the asking.
      consent: standingConsent([
        { terminalId: 't1', publicKey: aliceKey },
        { terminalId: 't2', publicKey: aliceKey }
      ]),
      runner: remoteRunner({ [cloneA]: ORIGIN_A, [cloneB]: ORIGIN_A, [private_]: ORIGIN_Z }),
      workspace: {
        projects: [project('p_main', cloneA), project('p_review', cloneB), project('p_private', private_)],
        worktrees: [
          worktree('wt_p_main', 'p_main', 'main', 'main'),
          worktree('wt_p_review', 'p_review', 'review', 'main'),
          worktree('wt_p_private', 'p_private', 'private', 'main')
        ],
        terminals: [pane('p_main', 't1'), pane('p_review', 't2'), pane('p_private', 't_secret')]
      }
    })
    await runtime.service.start()
    await scheduler.advance(0)
    cleanups.push(async () => {
      runtime.service.stop()
      await Promise.resolve()
    })
    return { runtime, aliceKey, linkId: linkIdFor(aliceKey, KEY_A) }
  }

  it('lets a teammate read every pane the one link offered them, not half of them', async () => {
    const { runtime, linkId } = await twoClones()
    expect(runtime.service.remoteRead(linkId, 't1')).toEqual({ ok: true })
    expect(runtime.service.remoteRead(linkId, 't2')).toEqual({ ok: true })
  })

  it('takes a keystroke for either clone and files it under the project the pane is in', async () => {
    const { runtime, linkId } = await twoClones()
    expect(runtime.service.remoteWrite(linkId, { terminalId: 't1', data: 'a', bytes: 1 })).toEqual({ ok: true })
    expect(runtime.service.remoteWrite(linkId, { terminalId: 't2', data: 'b', bytes: 1 })).toEqual({ ok: true })

    expect((await logOf(runtime)).map((entry) => ({ pane: entry.terminalId, projectId: entry.projectId }))).toEqual([
      { pane: 't1', projectId: 'p_main' },
      { pane: 't2', projectId: 'p_review' }
    ])
    expect(typistsOn(runtime, 'p_review', 't2').map((row) => row.writes)).toEqual([1])
  })

  it('still answers for a pane of a project they are not on exactly as for one that is not there', async () => {
    const { runtime, linkId } = await twoClones()
    const invented = runtime.service.remoteRead(linkId, 't_no_such_pane')
    const theirs = runtime.service.remoteRead(linkId, 't_secret')

    // Byte-identical but for the id they named: telling the two apart would
    // answer "is there a pane with this id somewhere on your machine".
    expect(theirs).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no pane t_secret in this project'
    })
    expect(invented).toEqual({ ...theirs, message: 'there is no pane t_no_such_pane in this project' })

    // The write path says it without the id, because that reason is also what
    // goes on the owner's disk — so the two writes are identical outright.
    const write = runtime.service.remoteWrite(linkId, { terminalId: 't_secret', data: 'x', bytes: 1 })
    expect(write).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'there is no such pane in this project'
    })
  })
})

describe('a refused keystroke leaves no mark on a project its sender is not on', () => {
  const malloryOnOneProject = async (): Promise<{ runtime: PeerRuntime; linkId: string }> => {
    const malloryData = await mkdtemp(join(tmpdir(), 'teamree-mallory-'))
    const malloryKey = (await loadIdentity(malloryData)).publicKey
    const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const ownerKey = (await loadIdentity(ownerData)).publicKey
    const shared = await makeProjectDir([
      { handle: 'owner', publicKey: ownerKey },
      { handle: 'mallory', publicKey: malloryKey }
    ])
    const alone = await makeProjectDir([{ handle: 'owner', publicKey: ownerKey }])

    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const runtime = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: ownerData,
      // Settled beforehand for the one pane she is allowed on, so the flood
      // below is measured against a record that really exists.
      consent: standingConsent([{ terminalId: 't_a1', publicKey: malloryKey }]),
      runner: remoteRunner({ [shared]: ORIGIN_A, [alone]: ORIGIN_Z }),
      workspace: {
        projects: [project('p_a', shared), project('p_b', alone)],
        worktrees: [worktree('wt_p_a', 'p_a', 'a', 'main'), worktree('wt_p_b', 'p_b', 'b', 'main')],
        terminals: [pane('p_a', 't_a1'), pane('p_b', 't_secret_b')]
      }
    })
    await runtime.service.start()
    await scheduler.advance(0)
    cleanups.push(async () => {
      runtime.service.stop()
      await Promise.resolve()
    })
    return { runtime, linkId: linkIdFor(malloryKey, KEY_A) }
  }

  it('does not put her name on a pane of another project she merely named', async () => {
    const { runtime, linkId } = await malloryOnOneProject()
    const verdict = decided(runtime.service.remoteWrite(linkId, { terminalId: 't_secret_b', data: 'x', bytes: 1 }))
    expect(verdict.ok).toBe(false)

    // The owner's window for the other project must have nothing to show: a
    // private project labelled as one whose history is not the owner's alone is
    // also a confirmation channel for pane ids, against their own screen.
    expect(runtime.service.watchers({ projectId: 'p_b' }).panes).toEqual([])
  })

  it('cannot flood away the owner’s live record of a pane she really typed into', async () => {
    const { runtime, linkId } = await malloryOnOneProject()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'deploy\n', bytes: 7 })
    expect(typistsOn(runtime, 'p_a', 't_a1')).toHaveLength(1)

    // Six hundred refusals at ids she invented, which is more than the map
    // holds, aimed at evicting the one entry that is evidence.
    for (let index = 0; index < 600; index += 1) {
      runtime.service.remoteWrite(linkId, { terminalId: `junk_${index}`, data: 'x', bytes: 1 })
    }

    expect(typistsOn(runtime, 'p_a', 't_a1').map((row) => row.writes)).toEqual([1])
  })

  it('cannot flood away the owner’s log of a keystroke she really sent', async () => {
    const { runtime, linkId } = await malloryOnOneProject()
    runtime.service.remoteWrite(linkId, { terminalId: 't_a1', data: 'deploy\n', bytes: 7 })

    // Enough refusals to roll both generations of a log that files every one.
    // Sent in bursts with the log allowed to reach the disk between them,
    // because that is how a flood off a wire arrives: not in one process tick.
    for (let burst = 0; burst < 14; burst += 1) {
      for (let index = 0; index < 1_000; index += 1) {
        runtime.service.remoteWrite(linkId, { terminalId: `junk_${burst}_${index}`, data: 'x', bytes: 1 })
      }
      await runtime.service.writeLog({ limit: 1 })
    }

    const writes = await logOf(runtime)
    expect(writes.some((entry) => entry.outcome === 'written' && entry.terminalId === 't_a1')).toBe(true)
    // And the refusals are still visible as a fact, collapsed rather than lost.
    expect(writes.filter((entry) => entry.outcome !== 'written').length).toBeGreaterThan(0)
  })
})

describe('the log says written only for keystrokes a pane took', () => {
  it('refuses a pane whose child has been reaped but whose output is still draining', async () => {
    const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const ownerKey = (await loadIdentity(ownerData)).publicKey
    const aliceData = await mkdtemp(join(tmpdir(), 'teamree-alice-'))
    const aliceKey = (await loadIdentity(aliceData)).publicKey
    const dir = await makeProjectDir([
      { handle: 'owner', publicKey: ownerKey },
      { handle: 'alice', publicKey: aliceKey }
    ])

    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const runtime = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: ownerData,
      runner: remoteRunner({ [dir]: ORIGIN_A }),
      workspace: {
        projects: [project('p_a', dir)],
        worktrees: [worktree('wt_p_a', 'p_a', 'a', 'main')],
        // The shape a pane is in for up to half a second after every exit: the
        // process is gone, the scrollback is still arriving, and a write throws.
        terminals: [pane('p_a', 't_a1', { running: true, draining: true })]
      }
    })
    await runtime.service.start()
    await scheduler.advance(0)
    cleanups.push(async () => {
      runtime.service.stop()
      await Promise.resolve()
    })

    const verdict = runtime.service.remoteWrite(linkIdFor(aliceKey, KEY_A), {
      terminalId: 't_a1',
      data: 'x',
      bytes: 1
    })
    expect(verdict).toEqual({
      ok: false,
      code: ErrorCode.NotFound,
      message: 'that pane’s process has exited'
    })
    expect((await logOf(runtime)).map((entry) => entry.outcome)).toEqual(['no-pane'])
  })

  it.skipIf(!canSpawnPty())('reports a real pty as draining for as long as it refuses writes', async () => {
    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const dir = await makeProjectDir([])
    const runtime = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      withTerminals: true,
      env: {},
      runner: remoteRunner({ [dir]: ORIGIN_A }),
      workspace: {
        projects: [project('p_a', dir)],
        worktrees: [worktree('wt_p_a', 'p_a', 'a', 'main')],
        terminals: []
      }
    })
    const manager = runtime.terminals?.manager
    if (!manager) throw new Error('the runtime was built without terminals')
    cleanups.push(() => runtime.terminals?.shutdown() ?? Promise.resolve())

    const created = await runtime.terminals?.handlers['terminal.create']({
      worktreeId: 'wt_p_a',
      command: 'exit 0'
    })
    const id = created?.id ?? ''

    // The window this is about: the child is reaped, `write` already throws,
    // and the pane still reports itself as running.
    const deadline = Date.now() + 10_000
    let caught: Terminal | undefined
    while (caught === undefined && Date.now() < deadline) {
      const snapshot = manager.list('wt_p_a').find((row) => row.id === id)
      if (snapshot === undefined) break
      if (!snapshot.running) break
      try {
        manager.write(id, 'x')
      } catch {
        caught = snapshot
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    expect(caught?.running).toBe(true)
    expect(caught?.draining).toBe(true)
  })
})

describe('a roster that could not be read is not a team nobody has joined', () => {
  it('says the read failed rather than making a statement about the people', async () => {
    const ownerData = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const dir = await mkdtemp(join(tmpdir(), 'teamree-project-'))
    const members = join(dir, ...MEMBERS_DIR_SEGMENTS)
    await mkdir(dirname(members), { recursive: true })
    // A members directory that cannot be listed. The transient shapes of this
    // are EACCES, EIO and EMFILE; every one of them, and this one, arrives here
    // as a rejected read rather than as an empty roster.
    await writeFile(members, 'not a directory', 'utf8')
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const relay = createFakeRelay()
    const scheduler = createManualScheduler()
    const runtime = await createPeerRuntime({
      dial: relay.dial,
      scheduler,
      env: { TEAMREE_RELAY_URL: RELAY_URL },
      dataDir: ownerData,
      runner: remoteRunner({ [dir]: ORIGIN_A }),
      workspace: { projects: [project('p_a', dir)], worktrees: [], terminals: [] }
    })
    await runtime.service.start()
    await scheduler.advance(0)
    cleanups.push(async () => {
      runtime.service.stop()
      await Promise.resolve()
    })

    const reason = statusOf(runtime.service, 'p_a').disabledReason
    expect(reason).not.toBe('nobody has joined this project yet, so there is no roster to meet anyone from')
    expect(reason).toMatch(/roster could not be read/)
  })
})

describe('a mute is the owner’s standing decision, not this process’s', () => {
  /**
   * A pane comes back from a restart under the id it had — `session-restore.ts`
   * keeps it on purpose — so a mute that does not come back with it is a
   * decision quietly discarded at the moment it is least visible.
   */
  const serviceOver = async (options: {
    dataDir: string
    dir: string
    mutes: { list: () => readonly string[]; set: (terminalId: string, muted: boolean) => void }
  }): Promise<PeerService> => {
    const service = new PeerService({
      workspace: {
        listProjects: () => [project('p_a', options.dir)],
        listWorktrees: (projectId) =>
          projectId === undefined || projectId === 'p_a' ? [worktree('wt_a', 'p_a', 'a', 'main')] : [],
        listTerminals: (worktreeId) => (worktreeId === 'wt_a' ? [terminal('t_a1', 'wt_a')] : [])
      },
      dataDir: options.dataDir,
      subscriptions: new SubscriptionHub(),
      runner: remoteRunner({ [options.dir]: ORIGIN_A }),
      dial: createFakeRelay().dial,
      env: {},
      mutes: options.mutes,
      onChange: () => {}
    })
    await service.start()
    cleanups.push(async () => {
      service.stop()
      await Promise.resolve()
    })
    return service
  }

  it('is still in force when the pane comes back under the same id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const dir = await makeProjectDir([])
    const kept = new Set<string>()
    const mutes = {
      list: (): readonly string[] => [...kept],
      set: (terminalId: string, muted: boolean): void => {
        if (muted) kept.add(terminalId)
        else kept.delete(terminalId)
      }
    }

    const before = await serviceOver({ dataDir, dir, mutes })
    before.mute({ terminalId: 't_a1', muted: true })
    expect(before.watchers({ projectId: 'p_a' }).panes).toEqual([
      { terminalId: 't_a1', watchers: [], typists: [], muted: true }
    ])
    before.stop()

    // The app is restarted. `session-restore.ts` brings the pane back under the
    // id it had, and the owner is not asked again.
    const after = await serviceOver({ dataDir, dir, mutes })
    expect(after.watchers({ projectId: 'p_a' }).panes).toEqual([
      { terminalId: 't_a1', watchers: [], typists: [], muted: true }
    ])
  })

  it('is lifted everywhere when the owner lifts it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'teamree-owner-'))
    const dir = await makeProjectDir([])
    const kept = new Set<string>(['t_a1'])
    const mutes = {
      list: (): readonly string[] => [...kept],
      set: (terminalId: string, muted: boolean): void => {
        if (muted) kept.add(terminalId)
        else kept.delete(terminalId)
      }
    }

    const service = await serviceOver({ dataDir, dir, mutes })
    service.mute({ terminalId: 't_a1', muted: false })
    expect(service.watchers({ projectId: 'p_a' }).panes).toEqual([])
    expect([...kept]).toEqual([])
  })
})
