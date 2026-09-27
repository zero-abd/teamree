// A leftover index.lock, against real git: every write reports it as `locked` with the path, and Clear
// Lock removes it only when no git runs in that checkout and the lock is not fresh.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { parsePatch } from '../../shared/patch'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { listGitProcesses, STALE_LOCK_MS, type GitProcess, type GitProcesses } from './indexLock'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

type Tree = { repo: TempRepo; service: GitService; parent: Worktree; child: Worktree }

async function tree(gitProcesses?: GitProcesses): Promise<Tree> {
  const repo = await createTempRepo({ withRemote: true })
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...(gitProcesses ? { gitProcesses } : {}) })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
  await repo.write('auth.ts', 'one\ntwo\nthree\n', parent.path)
  await repo.commit('parent work', parent.path)
  const child = await ready(service, { projectId: project.id, name: 'Write tests', parentId: parent.id })
  return { repo, service, parent, child }
}

async function ready(service: GitService, params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const settled = await service.whenSettled((await service.createWorktree(params)).id)
  if (settled.state !== 'ready') throw new Error(settled.error)
  return settled
}

/** Leaves `index.lock` where git keeps it for `checkout`, `ageMs` old. */
async function lockIndex(repo: TempRepo, checkout: string, ageMs = 0): Promise<string> {
  const lockPath = path.resolve(checkout, await repo.git(['rev-parse', '--git-path', 'index.lock'], checkout))
  await writeFile(lockPath, '')
  const at = new Date(Date.now() - ageMs)
  await utimes(lockPath, at, at)
  return lockPath
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

const noGit: GitProcesses = async () => []

describe('every git write reports a held index lock', () => {
  it('commit, stage, unstage and discard', async () => {
    const { repo, service, child } = await tree()
    await repo.write('auth.ts', 'one\nTWO\nthree\n', child.path)
    await repo.write('staged.ts', 'x\n', child.path)
    await repo.git(['add', 'staged.ts'], child.path)
    const [file] = parsePatch(`${await repo.git(['diff', '--no-color', '--', 'auth.ts'], child.path)}\n`)
    const hunk = file!.hunks[0]!
    const lockPath = await lockIndex(repo, child.path)
    const worktreeId = child.id

    for (const attempt of [
      () => service.worktreeCommit({ worktreeId, message: 'm', all: true }),
      () => service.worktreeStageHunk({ worktreeId, path: 'auth.ts', hunk }),
      () => service.worktreeUnstagePath({ worktreeId, path: 'staged.ts' }),
      () => service.worktreeDiscardPath({ worktreeId, path: 'auth.ts' })
    ]) {
      const error = await rejection(attempt())
      expect(error.code).toBe(ErrorCode.GitFailed)
      expect(error.data).toEqual({ kind: 'locked', lockPath })
    }
  })

  it('update and merge', async () => {
    const { repo, service, parent, child } = await tree()
    await repo.write('session.ts', 'more\n', parent.path)
    await repo.commit('parent moved', parent.path)
    const childLock = await lockIndex(repo, child.path)
    expect((await rejection(service.worktreeUpdate({ worktreeId: child.id }))).data).toEqual({
      kind: 'locked',
      lockPath: childLock
    })

    await rm(childLock)
    await repo.write('auth.test.ts', 'tests\n', child.path)
    await repo.commit('child tests', child.path)
    const parentLock = await lockIndex(repo, parent.path)
    const merging = await rejection(service.worktreeMergeIntoBase({ worktreeId: child.id }))
    expect(merging.data).toEqual({
      kind: 'locked',
      lockPath: parentLock
    })
  })
})

describe('Clear Lock', () => {
  it('removes a stale lock nobody holds, and the commit then goes through', async () => {
    const { repo, service, child } = await tree(noGit)
    await repo.write('notes.md', 'n\n', child.path)
    const lockPath = await lockIndex(repo, child.path, STALE_LOCK_MS + 1_000)

    expect(await service.worktreeLock({ worktreeId: child.id, lockPath })).toMatchObject({
      lockPath,
      exists: true,
      gitRunning: false,
      clearable: true
    })
    await service.worktreeClearLock({ worktreeId: child.id, lockPath })
    expect(existsSync(lockPath)).toBe(false)
    expect((await service.worktreeCommit({ worktreeId: child.id, message: 'notes', all: true })).paths).toEqual([
      'notes.md'
    ])
  })

  it('leaves a fresh lock alone', async () => {
    const { repo, service, child } = await tree(noGit)
    const lockPath = await lockIndex(repo, child.path)

    expect(await service.worktreeLock({ worktreeId: child.id, lockPath })).toMatchObject({ clearable: false })
    const refused = await rejection(service.worktreeClearLock({ worktreeId: child.id, lockPath }))
    expect(refused.code).toBe(ErrorCode.Conflict)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('leaves the lock alone while a git process runs in that checkout', async () => {
    let listed: GitProcess[] = []
    const { repo, service, child } = await tree(async () => listed)
    const lockPath = await lockIndex(repo, child.path, STALE_LOCK_MS + 1_000)
    listed = [{ pid: 1, cwd: child.path, args: 'git cat-file --batch' }]

    expect(await service.worktreeLock({ worktreeId: child.id, lockPath })).toMatchObject({
      gitRunning: true,
      clearable: false
    })
    const refused = await rejection(service.worktreeClearLock({ worktreeId: child.id, lockPath }))
    expect(refused.code).toBe(ErrorCode.Conflict)
    expect(existsSync(lockPath)).toBe(true)

    listed = []
    expect(await service.worktreeLock({ worktreeId: child.id, lockPath })).toMatchObject({ clearable: true })
  })

  it('counts a git in another checkout as nobody, and one it cannot list as somebody', async () => {
    let listed: GitProcess[] | null = []
    const { repo, service, parent, child } = await tree(async () => listed)
    const lockPath = await lockIndex(repo, child.path, STALE_LOCK_MS + 1_000)
    const read = () => service.worktreeLock({ worktreeId: child.id, lockPath })

    listed = [{ pid: 1, cwd: parent.path, args: 'git status' }]
    expect(await read()).toMatchObject({ gitRunning: false, clearable: true })
    listed = [{ pid: 1, cwd: path.join(child.path, 'src'), args: 'git add .' }]
    expect(await read()).toMatchObject({ gitRunning: true, clearable: false })
    listed = [{ pid: 1, cwd: '/', args: `git -C ${child.path} commit` }]
    expect(await read()).toMatchObject({ gitRunning: true, clearable: false })
    // Gone before its cwd was read, or another user's: only its arguments place it.
    listed = [{ pid: 1, cwd: null, args: 'git fetch' }]
    expect(await read()).toMatchObject({ gitRunning: false, clearable: true })
    listed = [{ pid: 1, cwd: null, args: `git -C ${child.path}/src add .` }]
    expect(await read()).toMatchObject({ gitRunning: true, clearable: false })
    listed = [{ pid: 1, cwd: `${child.path}-other`, args: `git -C ${child.path}-other status` }]
    expect(await read()).toMatchObject({ gitRunning: false, clearable: true })
    listed = null
    expect(await read()).toMatchObject({ gitRunning: true, clearable: false })
  })

  it('refuses any path that is not an index lock of this repository', async () => {
    const { repo, service, child } = await tree(noGit)
    const stray = path.join(repo.base, 'index.lock')
    await writeFile(stray, '')

    const refused = await rejection(service.worktreeClearLock({ worktreeId: child.id, lockPath: stray }))
    expect(refused.code).toBe(ErrorCode.InvalidParams)
    expect(existsSync(stray)).toBe(true)
  })
})

describe('listGitProcesses', () => {
  it('finds a running git and where it runs', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const running = spawn('git', ['cat-file', '--batch'], { cwd: repo.repoPath, stdio: 'pipe' })
    children.push(running)
    await new Promise((resolve) => running.once('spawn', resolve))

    const found = (await listGitProcesses())?.find((each) => each.pid === running.pid)
    expect(found).toMatchObject({ cwd: repo.repoPath })
    expect(found?.args).toContain('cat-file')
  })
})
