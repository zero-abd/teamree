// The other three reads in the window `statusBeforeReconcile.test.ts` opened. `presence` gets the
// union: an empty roster is a finding. `watchers` and `requests` get an answer: every fact in them is
// this machine's own, and a project with no facts has no links. Asked through the dispatcher, as real callers do.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PaneConsent, PaneWatchers, TeammatePresence } from '../../../shared/entities'
import { ErrorCode } from '../../../shared/protocol'
import type { Response } from '../../../shared/protocol'
import {
  createManualScheduler,
  fixedRemoteRunner,
  createPeerRuntime,
  makeProjectDir,
  project,
  standingConsent,
  standingMutes,
  terminal,
  worktree,
  type PeerRuntime
} from './peerTestSupport'

const ORIGIN = 'git@github.com:team/app.git'
/** A well-formed X25519 key, so the roster parses and "the handle is missing" below is the unread window. */
const ANA = `AQID${'A'.repeat(39)}=`

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * One project with a worktree of two panes — one muted, one with a standing permission — and a second
 * project (`p_two`) pushed onto the workspace after the last reconcile, as `project.add` does before its
 * event reaches the peer service. No relay anywhere, so no link is ever dialled.
 */
async function runtimeWithAnUnreadProject(): Promise<PeerRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-unread-reads-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const oneDir = await makeProjectDir([])
  cleanups.push(() => rm(oneDir, { recursive: true, force: true }))
  const twoDir = await makeProjectDir([{ handle: 'ana', publicKey: ANA }])
  cleanups.push(() => rm(twoDir, { recursive: true, force: true }))

  const runtime = await createPeerRuntime({
    workspace: {
      projects: [project('p_one', oneDir)],
      worktrees: [worktree('w_two', 'p_two', 'fix-login', 'feature/fix-login')],
      terminals: [terminal('t_muted', 'w_two'), terminal('t_allowed', 'w_two')]
    },
    dial: () => {
      throw new Error('this test never reaches a relay')
    },
    scheduler: createManualScheduler(),
    runner: fixedRemoteRunner(ORIGIN),
    // The decisions the owner took in an earlier session, which `start()` restores before it reconciles.
    mutes: standingMutes(['t_muted']),
    consent: standingConsent([{ terminalId: 't_allowed', publicKey: ANA }]),
    dataDir,
    env: {}
  })
  cleanups.push(async () => {
    runtime.service.stop()
    await Promise.resolve()
  })
  await runtime.service.start()
  // After the reconcile, so the project is one the store has and the peer service has not read.
  runtime.workspace.projects.push(project('p_two', twoDir))
  return runtime
}

let asked = 0

/** The raw response, because whether this is an answer at all is the question. */
async function ask(runtime: PeerRuntime, method: string, projectId: string): Promise<Response> {
  asked += 1
  return runtime.dispatch({ id: `ask_${asked}`, method, params: { projectId } }, { connectionId: 'window' })
}

async function answer<T>(runtime: PeerRuntime, method: string, projectId: string): Promise<T> {
  const response = await ask(runtime, method, projectId)
  expect(response).toMatchObject({ ok: true })
  return (response as { result: T }).result
}

it('says the roster has not been read rather than that nobody is on it', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  const presence = await answer<TeammatePresence>(runtime, 'teamwork.presence', 'p_two')

  expect(presence.state).toBe('unread')
  expect(presence.projectId).toBe('p_two')
  // No roster of any length: `teammates: []` would say the repository was read and holds nobody.
  expect(presence).not.toHaveProperty('teammates')
  expect(presence).not.toHaveProperty('worktrees')

  // A read the moment the reconcile has run. The roster it lays out is empty, and that empty roster is
  // the finding the answer above must not be confused with: same shape, opposite claim.
  await runtime.service.reconcile()
  const read = await answer<TeammatePresence>(runtime, 'teamwork.presence', 'p_two')
  expect(read.state).toBe('read')
  if (read.state !== 'read') throw new Error('unreachable')
  expect(read.teammates).toEqual([])
})

it('reports a pane the owner muted last week before it has read the project', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  const watchers = await answer<PaneWatchers>(runtime, 'teamwork.watchers', 'p_two')

  // Not a union: the mute is this machine's own record of its owner's decision, restored in `start()`.
  expect(watchers.projectId).toBe('p_two')
  expect(watchers.panes.map((pane) => pane.terminalId)).toEqual(['t_muted'])
  expect(watchers.panes[0]?.muted).toBe(true)
  // Nobody reading or typing, which is true rather than assumed: both arrive over a link.
  expect(watchers.panes[0]?.watchers).toEqual([])
  expect(watchers.panes[0]?.typists).toEqual([])
})

it('lists a standing permission on an unread project rather than denying the project', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  const waiting = await answer<PaneConsent>(runtime, 'teamwork.requests', 'p_two')

  expect(waiting.projectId).toBe('p_two')
  // A permission the owner cannot see is a permission they cannot lift.
  expect(waiting.standing.map((grant) => grant.terminalId)).toEqual(['t_allowed'])
  expect(waiting.standing[0]?.publicKey).toBe(ANA)
  // Named by key rather than by handle: the one thing the unread roster costs this answer.
  expect(waiting.standing[0]?.handle).toBe(ANA.slice(0, 8))
  // Nothing held: a held burst arrives over a link there cannot be one of yet.
  expect(waiting.requests).toEqual([])

  // And the handle fills in behind the reconcile, on the same grant.
  await runtime.service.reconcile()
  const read = await answer<PaneConsent>(runtime, 'teamwork.requests', 'p_two')
  expect(read.standing[0]?.handle).toBe('ana')
})

it('still says "no such project" about a project that does not exist', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  for (const method of ['teamwork.presence', 'teamwork.watchers', 'teamwork.requests']) {
    const response = await ask(runtime, method, 'p_nowhere')
    expect(response).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
  }
})

it('refuses a teammate’s pane on an unread project without calling the project missing', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  // The one read here that still fails, and should: an unread project has no roster to find the pane on.
  // What it owed the caller was the right refusal — "ask again", not "check the id you typed".
  const response = await runtime.dispatch(
    {
      id: 'watch_unread',
      method: 'teamwork.watch',
      params: { projectId: 'p_two', paneId: `peer:${'b'.repeat(12)}:t1` }
    },
    { connectionId: 'window' }
  )

  expect(response).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
  const { message } = (response as { error: { message: string } }).error
  expect(message).toContain('has not read project p_two yet')
  expect(message).not.toContain('no project with id')
})
