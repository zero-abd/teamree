// A checkout deleted, emptied or moved behind the app's back: seen on a listing, a status read, a watcher's
// report and a launch; never read as clean; and brought back by Restore or Locate, or removed.

import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { checkoutPresence } from './checkoutPresence'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Setup = { repo: TempRepo; service: GitService; worktree: Worktree; updates: Worktree[] }

/** A ready worktree with one commit of its own, so a recreated checkout can be told from a fresh one. */
async function setup(): Promise<Setup> {
  const repo = await createTempRepo()
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  const pending = await service.createWorktree({ projectId: project.id, name: 'ghost' })
  const worktree = await service.whenSettled(pending.id)
  await repo.write('ghost.txt', 'kept\n', worktree.path)
  await repo.commit('Ghost work', worktree.path)
  const updates: Worktree[] = []
  service.events.on((event) => {
    if (event.type === 'worktree.updated') updates.push(event.worktree)
  })
  return { repo, service, worktree, updates }
}

async function refusal(promise: Promise<unknown>): Promise<GitServiceError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(GitServiceError)
  return error as GitServiceError
}

const record = (service: GitService, id: string): Worktree | undefined =>
  service.snapshot().worktrees.find((worktree) => worktree.id === id)

describe('seeing a checkout go', () => {
  it('marks the record missing on a status read, with no listing first, and reads nothing as clean', async () => {
    const { service, worktree, updates } = await setup()
    await rm(worktree.path, { recursive: true, force: true })

    const status = await service.worktreeStatus({ worktreeId: worktree.id })

    expect(status.missing).toBe(true)
    expect(record(service, worktree.id)?.missing).toBe(true)
    expect(updates.map((row) => row.missing)).toEqual([true])
  })

  it('counts an empty folder in its place as missing, not as a clean checkout', async () => {
    const { service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })
    await mkdir(worktree.path)

    const [listed] = await service.listWorktrees({ projectId: worktree.projectId })
    const status = await service.worktreeStatus({ worktreeId: worktree.id })

    expect(listed?.missing).toBe(true)
    expect(status.missing).toBe(true)
  })

  it('marks the worktrees a watcher names, and clears them once the checkout is back', async () => {
    const { repo, service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })

    await service.recheckCheckouts([worktree.id])
    expect(record(service, worktree.id)?.missing).toBe(true)

    await repo.git(['worktree', 'add', '-f', worktree.path, worktree.branch])
    await service.recheckCheckouts([worktree.id])
    expect(record(service, worktree.id)?.missing).toBeUndefined()
  })

  it('is missing on the first listing after a launch', async () => {
    const { repo, service, worktree } = await setup()
    const saved = service.snapshot()
    await rm(worktree.path, { recursive: true, force: true })

    const relaunched = new GitService({ worktreesRoot: repo.worktreesRoot })
    services.push(relaunched)
    relaunched.hydrate(saved)
    const listed = await relaunched.listWorktrees({})

    expect(listed.map((row) => [row.id, row.state, row.missing])).toEqual([[worktree.id, 'ready', true]])
  })
})

describe('Restore', () => {
  it('checks the branch out again where it was, with its commits', async () => {
    const { repo, service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })
    await service.listWorktrees({})

    const restored = await service.recreateCheckout({ worktreeId: worktree.id })

    expect(restored.missing).toBeUndefined()
    expect(await checkoutPresence(worktree.path)).toBe('present')
    expect(await repo.git(['log', '-1', '--format=%s'], worktree.path)).toBe('Ghost work')
    expect((await service.worktreeStatus({ worktreeId: worktree.id })).missing).toBeUndefined()
  })

  it('refuses a folder in the way, and leaves it alone', async () => {
    const { service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })
    await mkdir(worktree.path)
    await writeFile(path.join(worktree.path, 'mine.txt'), 'not yours\n')

    const error = await refusal(service.recreateCheckout({ worktreeId: worktree.id }))

    expect(error.code).toBe(ErrorCode.Conflict)
    expect(await readdir(worktree.path)).toEqual(['mine.txt'])
  })

  it('refuses a checkout that is there', async () => {
    const { service, worktree } = await setup()
    expect((await refusal(service.recreateCheckout({ worktreeId: worktree.id }))).code).toBe(ErrorCode.Conflict)
  })
})

describe('Locate', () => {
  it('re-points the record at the folder it was moved to, and git with it', async () => {
    const { repo, service, worktree } = await setup()
    const moved = path.join(repo.base, 'moved-ghost')
    await rename(worktree.path, moved)
    await service.listWorktrees({})

    const located = await service.locateCheckout({ worktreeId: worktree.id, path: moved })

    expect([located.path, located.missing]).toEqual([moved, undefined])
    expect(await checkoutPresence(moved)).toBe('present')
    expect(await repo.git(['worktree', 'list', '--porcelain'])).toContain(`worktree ${moved}`)
    expect((await service.worktreeStatus({ worktreeId: worktree.id })).branch).toBe(worktree.branch)
  })

  it('refuses a folder that is not a checkout of this repository', async () => {
    const { repo, service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })
    const other = path.join(repo.base, 'other')
    await mkdir(other)
    await repo.git(['init'], other)

    const error = await refusal(service.locateCheckout({ worktreeId: worktree.id, path: other }))

    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(record(service, worktree.id)?.path).toBe(worktree.path)
  })

  it('refuses a checkout another worktree already is', async () => {
    const { service, worktree } = await setup()
    const second = await service.whenSettled(
      (await service.createWorktree({ projectId: worktree.projectId, name: 'second' })).id
    )
    await rm(worktree.path, { recursive: true, force: true })

    const error = await refusal(service.locateCheckout({ worktreeId: worktree.id, path: second.path }))

    expect(error.code).toBe(ErrorCode.Conflict)
  })
})

describe('Remove from teamree', () => {
  it('forgets a deleted checkout and frees its branch, which keeps its commits', async () => {
    const { repo, service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })

    await service.forgetWorktree({ worktreeId: worktree.id })

    expect(record(service, worktree.id)).toBeUndefined()
    expect(await repo.git(['worktree', 'list', '--porcelain'])).not.toContain(worktree.path)
    expect(await repo.git(['log', '-1', '--format=%s', worktree.branch])).toBe('Ghost work')
  })

  it('leaves a folder that is not the checkout any more exactly as it is', async () => {
    const { repo, service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })
    await mkdir(worktree.path)
    await repo.git(['init'], worktree.path)
    await writeFile(path.join(worktree.path, 'mine.txt'), 'not yours\n')

    await service.forgetWorktree({ worktreeId: worktree.id })

    expect(record(service, worktree.id)).toBeUndefined()
    expect(existsSync(path.join(worktree.path, 'mine.txt'))).toBe(true)
    expect(await repo.git(['worktree', 'list', '--porcelain'])).not.toContain(worktree.path)
  })

  it('leaves such a folder alone on Delete Worktree too', async () => {
    const { service, worktree } = await setup()
    await rm(worktree.path, { recursive: true, force: true })
    await mkdir(worktree.path)
    await writeFile(path.join(worktree.path, 'mine.txt'), 'not yours\n')

    expect(await service.removeWorktree({ worktreeId: worktree.id, force: true })).toMatchObject({ removed: true })

    expect(existsSync(path.join(worktree.path, 'mine.txt'))).toBe(true)
  })
})
