// A project the workspace has and teamwork has not read yet.
//
// `project.add` writes the project to the store and emits an event; the
// reconcile that reads its `.teamree`, its origin and its roster runs off the
// back of that event, afterwards. For the length of that gap the peer service
// holds no facts about a project that is already in the sidebar — and it used
// to answer the only question anybody asks about it with "no project with id
// p_two", which is a sentence about a project that exists.
//
// Nobody saw it, because the one caller in the window catches and shows nothing
// for a moment. That is not what makes it wrong. The method is answered over
// IPC, over the CLI's socket and by anything either of those grows into, and
// the next caller to handle its errors properly would report a project gone
// while it sits on screen.
//
// Asked through the dispatcher, because that is the path both real callers
// take and because the difference under test is the difference between an
// answer and an error response.

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

/**
 * One runtime with one project already read, and no relay anywhere.
 *
 * No relay means no link is ever dialled, which keeps every answer below about
 * the one thing being tested: whether the facts for a project have been read.
 */
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
 * A project added since the last reconcile, and nothing else changed.
 *
 * The workspace is the store, so pushing to it is exactly what `project.add`
 * does before the event it emits reaches the peer service.
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
  // The whole of the fix: "not read yet" rather than "no such project", because
  // the project is in the sidebar and the second sentence is false about it.
  expect(status.state).toBe('unread')
  expect(status.projectId).toBe('p_two')
  // And nothing else. A relay of `null` beside a `disabledReason` would be this
  // machine reporting a finding it has not made.
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
  // Read, and with an honest finding in it: this project has no relay, which is
  // a thing to go and set up rather than a thing to wait for.
  if (status.state !== 'read') throw new Error('unreachable')
  expect(status.disabledReason).not.toBeNull()
})
