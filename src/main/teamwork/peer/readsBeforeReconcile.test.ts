// The other three reads, in the window `statusBeforeReconcile.test.ts` opened.
//
// `teamwork.status` was fixed first because it is the method the roadmap named.
// `teamwork.presence`, `teamwork.watchers` and `teamwork.requests` were left
// saying "no project with id p_two" about a project in the sidebar, with the
// note in that PR admitting it — and the trap that fix sprang is set in all
// three: `scripts/teamwork/two-peers.mjs` had been waiting for `status` to
// stop throwing and reading `.links` off whatever came back, so the day the
// method answered honestly the wait ended immediately and handed the next line
// a project with no facts in it. A caller doing the same to any of these three
// is a caller that would report a roster of nobody.
//
// The three do not get the same answer, and the differences are the point:
//
//   * `presence` gets the union, because its answer is a roster read off the
//     repository and an empty one is a finding. "Your team is not here" told to
//     somebody whose team is there is the same class of lie as `relay: null`.
//   * `watchers` and `requests` get an answer rather than a union, because
//     every fact in them is this machine's own. Watchers, typists and held
//     bursts all arrive over a link, and a project with no facts has no links,
//     so "nobody" is not an assumption. The mutes and the standing permissions
//     are stronger still: they are the owner's own decisions, restored before
//     the first reconcile, and the tests below assert they are reported at a
//     moment `presence` has nothing whatever to say.
//
// Asked through the dispatcher, for the reason the status tests are: it is the
// path both real callers take, and the difference under test is the difference
// between an answer and an error response.

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
/**
 * A well-formed X25519 key, because a roster refuses anything else — and this
 * test needs the roster to actually parse, so that "the handle is missing" below
 * is the unread window rather than a member file nobody could read.
 */
const ANA = `AQID${'A'.repeat(39)}=`

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * A runtime whose one project has a worktree with two panes, one of them muted
 * and one of them carrying a standing permission — and a second project the
 * workspace is given *after* the last reconcile.
 *
 * The unread project is `p_two` throughout. It is pushed straight onto the
 * workspace because that is exactly what `project.add` does before the event it
 * emits reaches the peer service: the store has it, and nothing has read it.
 *
 * No relay anywhere, so no link is ever dialled and every answer below is about
 * the one thing under test.
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
    // The decisions the owner took in an earlier session, which `start()`
    // restores before it reconciles anything.
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
  // After the reconcile, so the project is one the store has and the peer
  // service has not read — rather than one it read and found nothing in.
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
  // And no roster of any length, because that is the whole of the fix. `p_two`
  // has ana on its roster and this answer must not claim otherwise in either
  // direction: `teammates: []` would say the repository was read and holds
  // nobody, which is the sentence that empties somebody's sidebar.
  expect(presence).not.toHaveProperty('teammates')
  expect(presence).not.toHaveProperty('worktrees')

  // And it is a read the moment the reconcile behind the event has run, which
  // is what makes the answer above a wait rather than a verdict. The roster it
  // then lays out is empty, and that empty roster is the finding the one above
  // must not be confused with: this project has no relay, teamwork is off for
  // it, and nobody is expected of it. Same shape, opposite claim.
  await runtime.service.reconcile()
  const read = await answer<TeammatePresence>(runtime, 'teamwork.presence', 'p_two')
  expect(read.state).toBe('read')
  if (read.state !== 'read') throw new Error('unreachable')
  expect(read.teammates).toEqual([])
})

it('reports a pane the owner muted last week before it has read the project', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  const watchers = await answer<PaneWatchers>(runtime, 'teamwork.watchers', 'p_two')

  // Not a union and not an empty answer: the mute is this machine's own record
  // of its owner's decision, restored in `start()`, and a restored window
  // asking about a pane it is already drawing used to be told the project it
  // belongs to does not exist.
  expect(watchers.projectId).toBe('p_two')
  expect(watchers.panes.map((pane) => pane.terminalId)).toEqual(['t_muted'])
  expect(watchers.panes[0]?.muted).toBe(true)
  // And nobody reading or typing, which is true rather than assumed: both
  // arrive over a link, and a project teamwork has not read has no links.
  expect(watchers.panes[0]?.watchers).toEqual([])
  expect(watchers.panes[0]?.typists).toEqual([])
})

it('lists a standing permission on an unread project rather than denying the project', async () => {
  const runtime = await runtimeWithAnUnreadProject()

  const waiting = await answer<PaneConsent>(runtime, 'teamwork.requests', 'p_two')

  expect(waiting.projectId).toBe('p_two')
  // The permission the owner gave ana last session, on a pane of a project
  // whose roster has not been read back yet. A permission the owner cannot see
  // is a permission they cannot lift, and "no project with id p_two" is the
  // most complete way to hide one.
  expect(waiting.standing.map((grant) => grant.terminalId)).toEqual(['t_allowed'])
  expect(waiting.standing[0]?.publicKey).toBe(ANA)
  // Named by key rather than by handle, which is the one thing the unread
  // roster costs this answer — and is already what a key the roster does not
  // mention gets. A short name is not a false one.
  expect(waiting.standing[0]?.handle).toBe(ANA.slice(0, 8))
  // Nothing held, because a held burst is a teammate's keystroke and arrives
  // over a link there cannot be one of yet.
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

  // The one read here that still fails, and the one that should: it is asked to
  // act on a named pane of a named teammate, and an unread project has no
  // roster to find them on and no link to reach them over. What it owed the
  // caller was the right refusal — "ask again", not "check the id you typed".
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
