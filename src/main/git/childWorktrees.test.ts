// Child worktrees against a real repository: a child branches from its parent's tip, is measured
// against it, goes when it goes, and only agents are held to the depth and fan-out limits.

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { MAX_OPEN_CHILDREN } from '../../shared/tasks'
import { createDispatcher } from '../runtime/dispatcher'
import { MethodRegistry, WINDOW_CONNECTION_PREFIX } from '../runtime/methodRegistry'
import { createRuntimeContext } from '../runtime/runtimeContext'
import { SubscriptionHub } from '../runtime/subscriptionHub'
import { WorkspaceStore } from '../store/workspaceStore'
import { GitServiceError } from './errors'
import { GitService, type GitEvent } from './gitService'
import { registerGitHandlers } from './handlers'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function setup(
  storeFile?: string
): Promise<{ repo: TempRepo; service: GitService; project: Project; store?: WorkspaceStore }> {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.write('README.md', 'hello\n')
  await repo.commit('initial')
  const store = storeFile === undefined ? undefined : await WorkspaceStore.open(path.join(repo.base, storeFile))
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...(store ? { store } : {}) })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, project, ...(store ? { store } : {}) }
}

async function ready(service: GitService, params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const pending = await service.createWorktree(params)
  const settled = await service.whenSettled(pending.id)
  if (settled.state !== 'ready') throw new Error(`"${params.name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

async function rejection(promise: Promise<unknown>): Promise<GitServiceError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(GitServiceError)
    return error as GitServiceError
  }
  throw new Error('expected the promise to reject')
}

describe('a child worktree', () => {
  it('branches from the parent tip, is measured against the parent, and sits flat beside it', async () => {
    const { repo, service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    await repo.write('auth.ts', 'parent work\n', parent.path)
    await repo.commit('parent work', parent.path)
    const parentTip = await repo.git(['rev-parse', 'HEAD'], parent.path)

    const child = await ready(service, { projectId: project.id, name: 'Write migration', parentId: parent.id })

    expect(child.parentId).toBe(parent.id)
    expect(child.branch).toBe('rework-auth--write-migration')
    expect(child.baseRef).toBe('rework-auth')
    expect(child.startedFrom).toBe(parentTip)
    expect(await repo.git(['rev-parse', 'HEAD'], child.path)).toBe(parentTip)
    expect(path.dirname(child.path)).toBe(path.dirname(parent.path))
    expect(path.basename(child.path)).toBe('rework-auth--write-migration')

    await repo.write('migration.sql', 'create table\n', child.path)
    await repo.commit('child work', child.path)
    const log = await service.worktreeLog({ worktreeId: child.id })
    expect(log.commits.map((commit) => commit.subject)).toEqual(['child work'])
    expect((await service.worktreeStatus({ worktreeId: child.id })).ahead).toBe(1)
  })

  it('takes the next name when the parent--slug branch is taken, and nests by name only', async () => {
    const { repo, service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    await repo.git(['branch', 'rework-auth--tests', parent.branch])

    const child = await ready(service, { projectId: project.id, name: 'tests', parentId: parent.id })
    const grandchild = await ready(service, { projectId: project.id, name: 'fixtures', parentId: child.id })

    expect(child.branch).toBe('rework-auth--tests-2')
    expect(path.basename(child.path)).toBe('rework-auth--tests-2')
    expect(grandchild.branch).toBe('rework-auth--tests-2--fixtures')
    expect(path.basename(grandchild.path)).toBe('rework-auth--tests-2--fixtures')
    expect(path.dirname(grandchild.path)).toBe(path.dirname(parent.path))
  })

  it('refuses a parent that is not ready, from another project, or with a checkout', async () => {
    const { service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })

    expect((await rejection(service.createWorktree({ projectId: project.id, name: 'x', parentId: 'nope' }))).code).toBe(
      ErrorCode.NotFound
    )
    const checkout = service.createWorktree({ projectId: project.id, name: 'x', parentId: parent.id, checkout: 'main' })
    expect((await rejection(checkout)).code).toBe(ErrorCode.InvalidParams)
    const from = service.createWorktree({ projectId: project.id, name: 'x', parentId: parent.id, startedFrom: 'main' })
    expect((await rejection(from)).code).toBe(ErrorCode.InvalidParams)

    const other = await setup()
    const foreign = service.createWorktree({ projectId: other.project.id, name: 'x', parentId: parent.id })
    expect((await rejection(foreign)).code).toBe(ErrorCode.NotFound)
  })
})

describe('removing a parent', () => {
  it('is refused while it has children, and with children takes them first, each kept for restore', async () => {
    const { service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    const child = await ready(service, { projectId: project.id, name: 'migration', parentId: parent.id })
    const grandchild = await ready(service, { projectId: project.id, name: 'seed', parentId: child.id })

    const refused = await rejection(service.removeWorktree({ worktreeId: parent.id }))
    expect(refused.code).toBe(ErrorCode.Conflict)
    expect(refused.message).toContain('2 children')
    expect((await service.listWorktrees()).map((worktree) => worktree.id)).toHaveLength(3)

    const removed: string[] = []
    service.events.on((event: GitEvent) => {
      if (event.type === 'worktree.removed') removed.push(event.worktreeId)
    })
    await service.removeWorktree({ worktreeId: parent.id, children: true })

    expect(removed).toEqual([grandchild.id, child.id, parent.id])
    expect(await service.listWorktrees()).toEqual([])
    for (const gone of [parent, child, grandchild]) expect(existsSync(gone.path)).toBe(false)
    const restorable = await service.listRemovedWorktrees()
    expect(restorable.map((entry) => entry.worktreeId).sort()).toEqual([parent.id, child.id, grandchild.id].sort())
  })

  it('forgetting it leaves the children top-level, still measured against its branch', async () => {
    const { service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    const child = await ready(service, { projectId: project.id, name: 'migration', parentId: parent.id })

    await service.forgetWorktree({ worktreeId: parent.id })

    const orphan = await service.getWorktree({ worktreeId: child.id })
    expect(orphan.parentId).toBeUndefined()
    expect(orphan.baseRef).toBe(parent.branch)
  })

  it('forgetting it after its branch is gone falls back to the project base', async () => {
    const { repo, service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    const child = await ready(service, { projectId: project.id, name: 'migration', parentId: parent.id })
    await repo.git(['worktree', 'remove', '--force', parent.path])
    await repo.git(['branch', '-D', parent.branch])

    await service.forgetWorktree({ worktreeId: parent.id })

    const orphan = await service.getWorktree({ worktreeId: child.id })
    expect(orphan.parentId).toBeUndefined()
    expect(orphan.baseRef).toBeUndefined()
  })

  it('restore keeps the parent when it is still there, and drops it when it is not', async () => {
    const { service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    const child = await ready(service, { projectId: project.id, name: 'migration', parentId: parent.id })

    const alone = await service.removeWorktree({ worktreeId: child.id })
    const back = await service.restoreWorktree({ projectId: project.id, removedId: alone.trashId as string })
    expect(back.parentId).toBe(parent.id)
    expect(back.baseRef).toBe(parent.branch)

    await service.removeWorktree({ worktreeId: parent.id, children: true })
    const removed = await service.listRemovedWorktrees()
    const childCopy = removed.find((entry) => entry.worktreeId === child.id)
    const orphan = await service.restoreWorktree({ projectId: project.id, removedId: childCopy?.id as string })
    expect(orphan.parentId).toBeUndefined()
    expect(orphan.baseRef).toBe(parent.branch)
  })
})

describe('persistence', () => {
  it('keeps parentId across a restart, and clears it when salvage lost the parent', async () => {
    const { repo, service, project, store } = await setup('workspace.json')
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    const child = await ready(service, { projectId: project.id, name: 'migration', parentId: parent.id })
    const file = path.join(repo.base, 'workspace.json')
    await service.dispose()
    await store?.flush()

    const again = new GitService({ worktreesRoot: repo.worktreesRoot, store: await WorkspaceStore.open(file) })
    services.push(again)
    again.reviveRestoredRecords()
    expect((await again.getWorktree({ worktreeId: child.id })).parentId).toBe(parent.id)

    const document = JSON.parse(await readFile(file, 'utf8')) as { worktrees: Array<Record<string, unknown>> }
    document.worktrees = document.worktrees.map((row) => (row['id'] === parent.id ? { ...row, state: 'bogus' } : row))
    await writeFile(file, JSON.stringify(document))

    const salvaged = new GitService({ worktreesRoot: repo.worktreesRoot, store: await WorkspaceStore.open(file) })
    services.push(salvaged)
    salvaged.reviveRestoredRecords()
    const kept = await salvaged.getWorktree({ worktreeId: child.id })
    expect(kept.parentId).toBeUndefined()
    expect(kept.baseRef).toBe(parent.branch)
  })
})

describe('limits', () => {
  async function wire(): Promise<{
    service: GitService
    project: Project
    call: (connectionId: string, params: Record<string, unknown>) => Promise<Worktree>
  }> {
    const { repo, service, project } = await setup()
    const store = await WorkspaceStore.open(path.join(repo.base, 'unused.json'))
    const registry = new MethodRegistry(
      createRuntimeContext({ version: '0.0.0-test', store, subscriptions: new SubscriptionHub() })
    )
    registerGitHandlers(registry, service)
    const dispatch = createDispatcher(registry)
    let counter = 0
    const call = async (connectionId: string, params: Record<string, unknown>): Promise<Worktree> => {
      counter += 1
      const response = await dispatch({ id: `r${counter}`, method: 'worktree.create', params }, { connectionId })
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code })
      return service.whenSettled((response.result as Worktree).id)
    }
    return { service, project, call }
  }
  const WINDOW = `${WINDOW_CONNECTION_PREFIX}1`
  const SOCKET = 'socket_1'

  it('stops agents three deep, and lets a person in the window go deeper', async () => {
    const { project, call } = await wire()
    let parent = await call(SOCKET, { projectId: project.id, name: 'top' })
    for (const name of ['one', 'two', 'three']) {
      parent = await call(SOCKET, { projectId: project.id, name, parentId: parent.id })
    }

    const deep = { projectId: project.id, name: 'four', parentId: parent.id }
    await expect(call(SOCKET, deep)).rejects.toMatchObject({ code: ErrorCode.ChildLimit })
    await expect(call(WINDOW, { ...deep, fromTerminalId: 'term_1' })).rejects.toMatchObject({
      code: ErrorCode.ChildLimit
    })
    expect((await call(WINDOW, deep)).state).toBe('ready')
  })

  it('stops agents at six open children, and lets a person in the window add a seventh', async () => {
    const { project, call } = await wire()
    const parent = await call(WINDOW, { projectId: project.id, name: 'Rework auth session' })
    for (let index = 1; index <= MAX_OPEN_CHILDREN; index += 1) {
      await call(SOCKET, { projectId: project.id, name: `part ${index}`, parentId: parent.id })
    }

    const seventh = { projectId: project.id, name: 'part 7', parentId: parent.id }
    await expect(call(SOCKET, seventh)).rejects.toMatchObject({
      code: ErrorCode.ChildLimit,
      message: '6 open children under Rework auth session'
    })
    expect((await call(WINDOW, seventh)).parentId).toBe(parent.id)
  })
})
