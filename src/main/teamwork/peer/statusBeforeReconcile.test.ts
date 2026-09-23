// A project the workspace has and teamwork has not read yet: the gap between
// `project.add` and its reconcile. It used to answer "no project with id", a
// sentence about a project that exists. Asked through the dispatcher.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { TeamworkStatus } from '../../../shared/entities'
import { ErrorCode } from '../../../shared/protocol'
import type { Response } from '../../../shared/protocol'
import {
  createManualScheduler,
  createPeerRuntime,
  fixedRemoteRunner,
  makeProjectDir,
  project,
  type PeerRuntime
} from './peerTestSupport'

const ORIGIN = 'git@github.com:team/app.git'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** One runtime with one project already read, and no relay anywhere, so no link is ever dialled. */
async function runtimeWithOneProject(): Promise<PeerRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-unread-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const projectDir = await makeProjectDir([])
  cleanups.push(() => rm(projectDir, { recursive: true, force: true }))

  const runtime = await createPeerRuntime({
    workspace: { projects: [project('p_one', projectDir)], worktrees: [], terminals: [] },
    dial: () => {
      throw new Error('this test never reaches a relay')
    },
    scheduler: createManualScheduler(),
    runner: fixedRemoteRunner(ORIGIN),
    dataDir,
    env: {}
  })
  cleanups.push(async () => {
    runtime.service.stop()
    await Promise.resolve()
  })
  await runtime.service.start()
  return runtime
}

let asked = 0

/** The raw response, because whether this is an answer at all is the question. */
async function ask(runtime: PeerRuntime, projectId: string): Promise<Response> {
  asked += 1
  return runtime.dispatch(
    { id: `status_${asked}`, method: 'teamwork.status', params: { projectId } },
    { connectionId: 'window' }
  )
}

/**
 * A project added since the last reconcile: pushing to the workspace is what
 * `project.add` does before its event reaches the peer service.
 */
async function addedButNotReconciled(runtime: PeerRuntime): Promise<void> {
  const projectDir = await makeProjectDir([])
  cleanups.push(() => rm(projectDir, { recursive: true, force: true }))
  runtime.workspace.projects.push(project('p_two', projectDir))
}

it('answers for a project the workspace has and teamwork has not read yet', async () => {
  const runtime = await runtimeWithOneProject()
  await addedButNotReconciled(runtime)

  const response = await ask(runtime, 'p_two')

  expect(response).toMatchObject({ ok: true })
  const status = (response as { result: TeamworkStatus }).result
  // "Not read yet" rather than "no such project": the project is in the sidebar.
  expect(status.state).toBe('unread')
  expect(status.projectId).toBe('p_two')
  // And nothing else: a relay of `null` would be a finding this machine has not made.
  expect(status).not.toHaveProperty('disabledReason')
  expect(status).not.toHaveProperty('relay')
})

it('still says "no such project" about a project that does not exist', async () => {
  const runtime = await runtimeWithOneProject()

  const response = await ask(runtime, 'p_nowhere')

  expect(response).toMatchObject({ ok: false, error: { code: ErrorCode.NotFound } })
})

it('has the facts the moment the reconcile behind the event has run', async () => {
  const runtime = await runtimeWithOneProject()
  await addedButNotReconciled(runtime)
  expect(((await ask(runtime, 'p_two')) as { result: TeamworkStatus }).result.state).toBe('unread')

  // What `registerHandlers` does when the workspace emits `projects`.
  await runtime.service.reconcile()

  const status = ((await ask(runtime, 'p_two')) as { result: TeamworkStatus }).result
  expect(status.state).toBe('read')
  // Read, with an honest finding: no relay is a thing to set up, not to wait for.
  if (status.state !== 'read') throw new Error('unreachable')
  expect(status.disabledReason).not.toBeNull()
})
