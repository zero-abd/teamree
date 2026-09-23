// `teamwork.mute` and `teamwork.revoke` in the startup window: they resolved
// their project through the facts rather than the workspace, so a restored pane
// drawn muted by `watchers` refused to be unmuted. Asked through the dispatcher.

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
 * A runtime just back from a restart with last week's decisions in hand, and a
 * project the workspace has that nothing has read: `p_two` is pushed after the
 * reconcile, which is what `project.add` leaves behind for the length of the gap.
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

/** The same, for calls that must go through: a throw carrying the owner's sentence rather than `ok: false`. */
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

  // The pane is out of the answer because nothing is true of it any more.
  expect(after.projectId).toBe('p_two')
  expect(after.panes).toEqual([])
  // And out of the file, so the unmute outlives this runtime.
  expect(mutes.list()).toEqual([])
  // Asked again, as a window that redraws would.
  const read = await answer<PaneWatchers>(runtime, 'teamwork.watchers', { projectId: 'p_two' })
  expect(read.panes).toEqual([])
})

it('silences a pane of a project it has not read yet', async () => {
  const { runtime, mutes } = await restoredRuntime()

  const after = await answer<PaneWatchers>(runtime, 'teamwork.mute', { terminalId: 't_allowed', muted: true })

  expect(after.projectId).toBe('p_two')
  expect(after.panes.find((pane) => pane.terminalId === 't_allowed')?.muted).toBe(true)
  expect(mutes.list()).toContain('t_allowed')
  // A mute takes the narrower answers with it: a standing permission left
  // behind would make the mute last exactly as long as the next unmute.
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

  // The refusal that was always true: an id no project of this workspace has a pane under.
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
