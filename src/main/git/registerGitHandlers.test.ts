// Proof that the seam fits: the real runtime registry and dispatcher, driven
// with wire-shaped requests, backed by the real workspace store.

import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { WorkspaceStore } from '../store/workspaceStore'
import { GitService } from './gitService'
import { registerGitHandlers } from './handlers'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function wire(): Promise<{
  repo: TempRepo
  service: GitService
  call: (method: string, params?: unknown) => Promise<unknown>
  store: WorkspaceStore
}> {
  const repo = await createTempRepo()
  repos.push(repo)
  const store = await WorkspaceStore.open(path.join(repo.base, 'workspace.json'))
  const registry = new MethodRegistry(
    createRuntimeContext({ version: '0.0.0-test', store, subscriptions: new SubscriptionHub() })
  )
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, store })
  services.push(service)
  registerGitHandlers(registry, service)

  const dispatch = createDispatcher(registry)
  let counter = 0
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    counter += 1
    const response = await dispatch({ id: `r${counter}`, method, params }, { connectionId: 'test' })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
  return { repo, service, call, store }
}

describe('registerGitHandlers', () => {
  it('answers every git method through the runtime dispatcher', async () => {
    const { repo, service, call, store } = await wire()

    const project = (await call('project.add', { path: repo.repoPath })) as Project
    expect(project.name).toBe('repo')
    expect(store.listProjects()).toHaveLength(1) // records went to the workspace store

    const created = (await call('worktree.create', { projectId: project.id, name: 'wire me up' })) as Worktree
    expect(created.state).toBe('creating')
    await service.whenSettled(created.id)

    const listed = (await call('worktree.list', { projectId: project.id })) as Worktree[]
    expect(listed).toHaveLength(1)
    expect(listed[0]?.state).toBe('ready')
    expect(store.getWorktree(created.id)?.state).toBe('ready')

    const status = await call('worktree.status', { worktreeId: created.id })
    expect(status).toMatchObject({ worktreeId: created.id, branch: 'wire-me-up', staged: 0 })

    expect(await call('worktree.remove', { worktreeId: created.id, deleteBranch: true })).toEqual({ removed: true })
    expect(await call('project.remove', { projectId: project.id })).toEqual({ removed: true })
    expect(await call('project.list')).toEqual([])
  })

  it('keeps the service error code on the wire instead of collapsing to internal', async () => {
    const { call } = await wire()

    const dispatch = call('worktree.get', { worktreeId: 'nope' })

    await expect(dispatch).rejects.toThrow(/^not_found:/)
  })
})
