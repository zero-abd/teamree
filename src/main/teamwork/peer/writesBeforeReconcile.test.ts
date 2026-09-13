// The owner's own two controls, in the window the reads were fixed in.
//
// `statusBeforeReconcile.test.ts` opened it and `readsBeforeReconcile.test.ts`
// worked out the other three reads. Both left `teamwork.mute` and
// `teamwork.revoke` behind and one of them said so: they resolve their project
// through `#projectOfPane`, which walked the facts rather than the workspace,
// so acting on a restored pane during the startup window failed with "no pane
// of this machine with id t_muted".
//
// Which is the worse half of the same defect, because the read beside it was
// fixed first. `watchers` reports a mute restored in `start()` from the first
// frame after a restart, and `requests` reports a standing permission the same
// way — so the window could draw a muted pane and a permission the owner holds,
// and then refuse to lift either, saying the pane is not on this machine. A
// read that lies is bad; a control that visibly does nothing is worse, and the
// mute button in `TerminalView.tsx` renders straight off that row.
//
// Neither write needs a reconcile to do its work. The durable halves are files
// keyed by this machine's own terminal ids, loaded before the first repository
// is read; the in-memory halves are this machine's own; and the project, which
// is all `#projectOfPane` was ever asked for, is a fact the workspace holds.
// What a reconcile adds is links to notify, and the prompts a mute settles and
// the permissions it drops arrive over links — so an unread project has nothing
// for those loops to find rather than something they would miss.
//
// Asked through the dispatcher, for the reason the two tests above are: it is
// the path the window and the CLI both take, and the difference under test is
// the difference between doing the thing and an error response.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PaneConsent, PaneWatchers } from '../../../shared/entities'
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
/** A well-formed X25519 key, so the roster `p_two` carries actually parses. */
const ANA = `AQID${'A'.repeat(39)}=`

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Restored = {
  runtime: PeerRuntime
  /** The file the mute goes to, so a test can read back what outlives this runtime. */
  mutes: ReturnType<typeof standingMutes>
  /** The same for the permission, which records every write it is given. */
  consent: ReturnType<typeof standingConsent>
}

/**
 * A runtime that has just come back from a restart with last week's decisions
 * in hand, and a project the workspace has that nothing has read.
 *
 * The same shape `readsBeforeReconcile.test.ts` builds, because the point is
 * that these calls act on the rows those reads already answer with: `p_two` is
 * pushed onto the workspace after the reconcile, which is exactly what
 * `project.add` leaves behind for the length of the gap, and both of its panes
 * carry a decision the owner took in an earlier session.
 */
async function restoredRuntime(): Promise<Restored> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-unread-writes-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const oneDir = await makeProjectDir([])
  cleanups.push(() => rm(oneDir, { recursive: true, force: true }))
  const twoDir = await makeProjectDir([{ handle: 'ana', publicKey: ANA }])
  cleanups.push(() => rm(twoDir, { recursive: true, force: true }))

  const mutes = standingMutes(['t_muted'])
  const consent = standingConsent([{ terminalId: 't_allowed', publicKey: ANA }])

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
    mutes,
    consent,
    dataDir,
    env: {}
  })
  cleanups.push(async () => {
    runtime.service.stop()
    await Promise.resolve()
  })
  await runtime.service.start()
  // After the reconcile, so this is a project the store has and the peer
  // service has not read — rather than one it read and found nothing in.
  runtime.workspace.projects.push(project('p_two', twoDir))
  return { runtime, mutes, consent }
}

let asked = 0

/** The raw response, because whether this is done at all is the question. */
async function ask(runtime: PeerRuntime, method: string, params: Record<string, unknown>): Promise<Response> {
  asked += 1
  return runtime.dispatch({ id: `ask_${asked}`, method, params }, { connectionId: 'window' })
}

/**
 * The same, for the calls that must go through — and a throw rather than an
 * assertion when one does not, so that a refusal fails the test with the
 * sentence the owner would have been told rather than with `ok: false`. The
 * whole subject here is which sentence that is.
 */
async function answer<T>(runtime: PeerRuntime, method: string, params: Record<string, unknown>): Promise<T> {
  const response = await ask(runtime, method, params)
  if (!response.ok) throw new Error(`${method} was refused: ${response.error.message}`)
  return response.result as T
}

it('lifts a mute on a pane of a project it has not read yet', async () => {
  const { runtime, mutes } = await restoredRuntime()

  // The row the owner is looking at, from the read that was fixed first.
  const before = await answer<PaneWatchers>(runtime, 'teamwork.watchers', { projectId: 'p_two' })
  expect(before.panes.map((pane) => pane.terminalId)).toEqual(['t_muted'])
  expect(before.panes[0]?.muted).toBe(true)

  const after = await answer<PaneWatchers>(runtime, 'teamwork.mute', { terminalId: 't_muted', muted: false })

  // Not merely that nothing threw: the pane is out of the answer because
  // nothing is true of it any more — nobody is reading it, nobody has typed
  // into it, and it is no longer silenced.
  expect(after.projectId).toBe('p_two')
  expect(after.panes).toEqual([])
  // And out of the file as well, so the unmute outlives this runtime the way
  // the mute it lifted did.
  expect(mutes.list()).toEqual([])
  // Asked again, as a window that redraws would: the same answer from the read
  // and not only from the write's own return value.
  const read = await answer<PaneWatchers>(runtime, 'teamwork.watchers', { projectId: 'p_two' })
  expect(read.panes).toEqual([])
})

it('silences a pane of a project it has not read yet', async () => {
  const { runtime, mutes } = await restoredRuntime()

  const after = await answer<PaneWatchers>(runtime, 'teamwork.mute', { terminalId: 't_allowed', muted: true })

  expect(after.projectId).toBe('p_two')
  expect(after.panes.find((pane) => pane.terminalId === 't_allowed')?.muted).toBe(true)
  expect(mutes.list()).toContain('t_allowed')
  // A mute is the widest answer there is and takes the narrower ones with it. A
  // standing permission is narrower and outlives a runtime, so one left behind
  // would make this mute last exactly as long as the next unmute — which holds
  // here too, where the permission was restored rather than granted.
  const waiting = await answer<PaneConsent>(runtime, 'teamwork.requests', { projectId: 'p_two' })
  expect(waiting.standing).toEqual([])
})

it('lifts a standing permission on a project it has not read yet', async () => {
  const { runtime, consent } = await restoredRuntime()

  const before = await answer<PaneConsent>(runtime, 'teamwork.requests', { projectId: 'p_two' })
  expect(before.standing.map((grant) => grant.terminalId)).toEqual(['t_allowed'])

  const after = await answer<PaneConsent>(runtime, 'teamwork.revoke', {
    terminalId: 't_allowed',
    publicKey: ANA
  })

  expect(after.projectId).toBe('p_two')
  expect(after.standing).toEqual([])
  // Written through to the file as a removal, so ana is asked again the next
  // time she types rather than the next time this machine restarts.
  expect(consent.written).toEqual([{ terminalId: 't_allowed', publicKey: ANA, since: null }])
})

it('still refuses a pane this machine does not have', async () => {
  const { runtime } = await restoredRuntime()

  // The refusal that was always true, and is now the only one left: an id no
  // project of this workspace has a pane under. It reads exactly as it did,
  // because it always meant this — what was wrong was that it was said about
  // panes this machine did have.
  for (const call of [
    { method: 'teamwork.mute', params: { terminalId: 't_nowhere', muted: true } },
    { method: 'teamwork.revoke', params: { terminalId: 't_nowhere', publicKey: ANA } }
  ]) {
    const response = await ask(runtime, call.method, call.params)
    expect(response).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
    const { message } = (response as { error: { message: string } }).error
    expect(message).toBe('no pane of this machine with id t_nowhere')
  }
})
