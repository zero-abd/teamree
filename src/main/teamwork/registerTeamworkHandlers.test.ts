// Proof that the seam fits: the real runtime registry and dispatcher, driven
// with wire-shaped requests, against a real repository.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemberList, Project } from '../../shared/entities'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { WorkspaceStore } from '../store/workspaceStore'
import { registerTeamworkHandlers } from './handlers'
import { TeamworkService } from './teamworkService'

const repos: TempRepo[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function wire(): Promise<{ call: (method: string, params?: unknown) => Promise<unknown>; project: Project }> {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.git(['config', 'user.email', 'ada@example.com'])
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamree-seam-'))
  dirs.push(dataDir)

  const store = await WorkspaceStore.open(path.join(dataDir, 'workspace.json'))
  const project = store.putProject({ id: 'p1', name: 'repo', path: repo.repoPath, baseRef: 'main' })
  const registry = new MethodRegistry(
    createRuntimeContext({ version: '0.0.0-test', store, subscriptions: new SubscriptionHub() })
  )
  registerTeamworkHandlers(registry, new TeamworkService({ store, dataDir, runner: repo.runner }))

  const dispatch = createDispatcher(registry)
  let counter = 0
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    counter += 1
    const response = await dispatch({ id: `r${counter}`, method, params }, { connectionId: 'test' })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
  return { call, project }
}

describe('registerTeamworkHandlers', () => {
  it('answers both member methods through the runtime dispatcher', async () => {
    const { call, project } = await wire()

    const before = (await call('members.list', { projectId: project.id })) as MemberList
    expect(before.enrolled).toBe(false)
    expect(before.members).toEqual([])

    const joined = (await call('members.join', { projectId: project.id })) as MemberList
    expect(joined.enrolled).toBe(true)
    expect(joined.members.map((member) => member.handle)).toEqual(['ada'])

    const after = (await call('members.list', { projectId: project.id })) as MemberList
    expect(after.members).toEqual(joined.members)
  })

  it('keeps the service error code on the wire instead of collapsing to internal', async () => {
    const { call } = await wire()

    await expect(call('members.list', { projectId: 'nope' })).rejects.toThrow(/^not_found:/)
  })

  // A push that reports itself and a Stop beside it are only worth anything if
  // the window can reach them, and the window reaches everything through this
  // dispatcher. Null and `cancelled: false` are the honest answers for a
  // project that has never had a push: neither is an error.
  it('answers the two calls a running push is watched and stopped through', async () => {
    const { call, project } = await wire()

    expect(await call('teamwork.publishProgress', { projectId: project.id })).toBeNull()
    expect(await call('teamwork.cancelPublish', { projectId: project.id })).toEqual({ cancelled: false })
  })

  it('refuses a call with no project named, before any of this runs', async () => {
    const { call } = await wire()

    await expect(call('members.join', {})).rejects.toThrow(/^invalid_params:/)
  })
})
