import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService, type GitEvent, type GitServiceOptions } from './gitService'
import { createMemoryRecordStore } from './recordStore'
import { createTempRepo, type TempRepo } from './testRepository'
import { listTrash } from './worktreeTrash'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function newRepo(withRemote = false): Promise<TempRepo> {
  const repo = await createTempRepo({ withRemote })
  repos.push(repo)
  return repo
}

function newService(repo: TempRepo, options: GitServiceOptions = {}): GitService {
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...options })
  services.push(service)
  return service
}

async function readyWorktree(service: GitService, projectId: string, name: string): Promise<Worktree> {
  const settled = await service.whenSettled((await service.createWorktree({ projectId, name })).id)
  if (settled.state !== 'ready') throw new Error(`worktree "${name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

async function refusal(promise: Promise<unknown>): Promise<GitServiceError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(GitServiceError)
  return error as GitServiceError
}

describe('removing a worktree from teamree', () => {
  it('forgets the record and leaves the checkout, its edits and its branch on disk', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'keep me')
    await repo.write('draft.txt', 'unsaved work\n', worktree.path)
    const events: GitEvent[] = []
    service.events.on((event) => events.push(event))

    const result = await service.forgetWorktree({ worktreeId: worktree.id })

    expect(result).toEqual({ forgotten: true, checkoutLeftAt: worktree.path })
    expect(await service.listWorktrees({ projectId: project.id })).toEqual([])
    expect(existsSync(path.join(worktree.path, 'draft.txt'))).toBe(true)
    expect(await repo.git(['branch', '--list', worktree.branch])).toContain(worktree.branch)
    expect(await listTrash(repo.runner, repo.repoPath)).toEqual([])
    expect(events).toContainEqual({ type: 'worktree.removed', worktreeId: worktree.id, projectId: project.id })
  })

  it('offers the branch in Open Branch again, and opening it takes the same folder back as it is', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'come back')
    await repo.write('draft.txt', 'unsaved work\n', worktree.path)
    await service.forgetWorktree({ worktreeId: worktree.id })

    const { branches } = await service.listBranches({ projectId: project.id })
    expect(branches.map((branch) => branch.name)).toContain(worktree.branch)
    // The primary checkout's branch is never offered.
    expect(branches.map((branch) => branch.name)).not.toContain('main')

    const pending = await service.createWorktree({
      projectId: project.id,
      name: 'come back',
      checkout: worktree.branch
    })
    const back = await service.whenSettled(pending.id)

    expect(back).toMatchObject({ state: 'ready', branch: worktree.branch, path: worktree.path })
    expect(existsSync(path.join(back.path, 'draft.txt'))).toBe(true)
    const { branches: after } = await service.listBranches({ projectId: project.id })
    expect(after.map((branch) => branch.name)).not.toContain(worktree.branch)
  })

  it('refuses to take the primary checkout as a worktree', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const error = await refusal(service.createWorktree({ projectId: project.id, name: 'main', checkout: 'main' }))
    expect(error.code).toBe(ErrorCode.Conflict)
  })
})

describe('moving a project to the Trash', () => {
  it('counts what would be lost: uncommitted files, unpushed commits, worktrees', async () => {
    const repo = await newRepo(true)
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    await readyWorktree(service, project.id, 'one')
    await readyWorktree(service, project.id, 'two')
    await repo.write('local.txt', 'committed only here\n')
    await repo.commit('Local only')
    await repo.write('a.txt', 'a\n')
    await repo.write('b/c.txt', 'c\n')

    expect(await service.trashPreview({ projectId: project.id })).toEqual({
      uncommitted: 2,
      unpushed: 1,
      worktrees: 2
    })
  })

  it('removes its worktrees with a copy kept, trashes the folder, and forgets the project', async () => {
    const repo = await newRepo()
    const trashed: string[] = []
    const trash = vi.fn(async (target: string) => {
      trashed.push(target)
    })
    const service = newService(repo, { trash })
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'dirty')
    await repo.write('draft.txt', 'unsaved work\n', worktree.path)

    expect(await service.trashProject({ projectId: project.id })).toEqual({ trashed: true })

    expect(trashed).toEqual([project.path])
    expect(existsSync(worktree.path)).toBe(false)
    const kept = await listTrash(repo.runner, repo.repoPath)
    expect(kept.map((entry) => entry.note.worktree.id)).toEqual([worktree.id])
    expect(service.listProjects()).toEqual([])
    expect(await service.listWorktrees()).toEqual([])
  })

  it('keeps the project when the Trash refuses', async () => {
    const repo = await newRepo()
    const service = newService(repo, {
      trash: async () => {
        throw new Error('no trash here')
      }
    })
    const project = await service.addProject({ path: repo.repoPath })

    await expect(service.trashProject({ projectId: project.id })).rejects.toThrow('no trash here')
    expect(service.listProjects().map((entry) => entry.id)).toEqual([project.id])
  })

  it('refuses without a Trash to move to', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    expect((await refusal(service.trashProject({ projectId: project.id }))).code).toBe(ErrorCode.Conflict)
    expect(existsSync(repo.repoPath)).toBe(true)
  })

  it.each([
    ['the home folder', () => os.homedir()],
    ['the root', () => path.parse(os.homedir()).root],
    ['a folder above home', () => path.dirname(os.homedir())]
  ])('refuses %s, touching nothing', async (_, folder) => {
    const repo = await newRepo()
    const trash = vi.fn(async () => undefined)
    const store = createMemoryRecordStore()
    store.putProject({ id: 'p', name: 'home', path: folder(), baseRef: 'main' })
    const service = newService(repo, { trash, store })

    expect((await refusal(service.trashProject({ projectId: 'p' }))).code).toBe(ErrorCode.InvalidParams)
    expect(trash).not.toHaveBeenCalled()
    expect(service.listProjects()).toHaveLength(1)
  })

  it('refuses a path that is not a directory', async () => {
    const repo = await newRepo()
    const file = path.join(repo.base, 'file.txt')
    await writeFile(file, 'x')
    await mkdir(repo.worktreesRoot, { recursive: true })
    const trash = vi.fn(async () => undefined)
    const store = createMemoryRecordStore()
    store.putProject({ id: 'p', name: 'file', path: file, baseRef: 'main' })
    const service = newService(repo, { trash, store })

    expect((await refusal(service.trashProject({ projectId: 'p' }))).code).toBe(ErrorCode.InvalidParams)
    expect(trash).not.toHaveBeenCalled()
  })
})
