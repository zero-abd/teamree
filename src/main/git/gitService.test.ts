import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { createGitRunner } from './gitProcess'
import { canonicalPath } from './pathIdentity'
import { GitService, type GitEvent, type GitServiceOptions } from './gitService'
import { createGitHandlers } from './handlers'
import { createDelayedRunner, createTempRepo, type TempRepo, type TempRepoOptions } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function newRepo(options?: TempRepoOptions): Promise<TempRepo> {
  const repo = await createTempRepo(options)
  repos.push(repo)
  return repo
}

function newService(repo: TempRepo, options: GitServiceOptions = {}): GitService {
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, ...options })
  services.push(service)
  return service
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

async function readyWorktree(service: GitService, projectId: string, name: string): Promise<Worktree> {
  const pending = await service.createWorktree({ projectId, name })
  const settled = await service.whenSettled(pending.id)
  if (settled.state !== 'ready') throw new Error(`worktree "${name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

describe('projects', () => {
  it('adds a repository, derives its name, and prefers origin/HEAD as the base ref', async () => {
    const repo = await newRepo({ withRemote: true })
    const service = newService(repo)

    const project = await service.addProject({ path: repo.repoPath })

    expect(project.name).toBe('repo')
    // Stored resolved with separators normalised, which on Windows is not the input string.
    expect(project.path).toBe(canonicalPath(repo.repoPath))
    expect(project.baseRef).toBe('origin/main')
    expect(service.listProjects()).toEqual([project])
  })

  it('falls back to the checked-out branch when there is no remote', async () => {
    const repo = await newRepo()
    const service = newService(repo)

    const project = await service.addProject({ path: repo.repoPath, name: 'Custom Name' })

    expect(project.name).toBe('Custom Name')
    expect(project.baseRef).toBe('main')
  })

  it('rejects a directory that is not a git repository', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const plainDirectory = path.join(repo.base, 'plain')
    await mkdir(plainDirectory)

    const error = await rejection(service.addProject({ path: plainDirectory }))

    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(error.message).toContain('not a git repository')
    expect(error.data).toEqual({ refusal: 'not-a-repository' })
    expect(service.listProjects()).toEqual([])
  })

  it('initializes a plain folder with a first commit when asked, then adds it', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const plainDirectory = path.join(repo.base, 'plain')
    await mkdir(plainDirectory)
    for (const role of ['AUTHOR', 'COMMITTER']) {
      vi.stubEnv(`GIT_${role}_NAME`, 'Teamree Test')
      vi.stubEnv(`GIT_${role}_EMAIL`, 'test@teamree.invalid')
    }

    const project = await service.addProject({ path: plainDirectory, init: true })

    expect(project.path).toBe(canonicalPath(plainDirectory))
    expect(await repo.git(['rev-list', '--count', 'HEAD'], plainDirectory)).toBe('1')
    expect(await readyWorktree(service, project.id, 'first task')).toMatchObject({ state: 'ready' })
  })

  // Every create would branch from nothing and fail; the folder is turned away instead.
  it('refuses a repository with no commits', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const empty = path.join(repo.base, 'empty')
    await mkdir(empty)
    await repo.git(['init'], empty)

    const error = await rejection(service.addProject({ path: empty }))

    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(error.data).toEqual({ refusal: 'no-commits' })
    expect(service.listProjects()).toEqual([])
  })

  it('does not initialize over a repository that has no commits', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const empty = path.join(repo.base, 'empty')
    await mkdir(empty)
    await repo.git(['init'], empty)

    const error = await rejection(service.addProject({ path: empty, init: true }))

    expect(error.data).toEqual({ refusal: 'no-commits' })
  })

  it('refuses a path that is not a folder without offering to initialize it', async () => {
    const repo = await newRepo()
    const service = newService(repo)

    const error = await rejection(service.addProject({ path: path.join(repo.base, 'nowhere'), init: true }))

    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(error.data).toBeUndefined()
    expect(existsSync(path.join(repo.base, 'nowhere'))).toBe(false)
  })

  it('rejects a relative path and a repository that is already tracked', async () => {
    const repo = await newRepo()
    const service = newService(repo)

    expect((await rejection(service.addProject({ path: 'repo' }))).code).toBe(ErrorCode.InvalidParams)

    await service.addProject({ path: repo.repoPath })
    const duplicate = await rejection(service.addProject({ path: repo.repoPath }))
    expect(duplicate.code).toBe(ErrorCode.Conflict)
  })

  it('forgets a project and its worktrees without touching the checkouts on disk', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'keep me')

    await service.removeProject({ projectId: project.id })

    expect(service.listProjects()).toEqual([])
    expect(await service.listWorktrees({})).toEqual([])
    expect(existsSync(worktree.path)).toBe(true)
  })
})

describe('worktree.create', () => {
  it('returns immediately in state creating and transitions to ready in the background', async () => {
    const repo = await newRepo({ withRemote: true })
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const seen: GitEvent[] = []
    service.events.on((event) => seen.push(event))

    const pending = await service.createWorktree({ projectId: project.id, name: 'Fix the login page' })
    expect(pending.state).toBe('creating')
    expect(pending.branch).toBe('fix-the-login-page')
    expect(pending.startedFrom).toBe('origin/main')
    expect(pending.path.startsWith(repo.worktreesRoot)).toBe(true)

    const ready = await service.whenSettled(pending.id)
    expect(ready.state).toBe('ready')
    expect(ready.error).toBeUndefined()

    expect(existsSync(path.join(ready.path, 'README.md'))).toBe(true)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).toContain('fix-the-login-page')
    const listed = await repo.git(['worktree', 'list', '--porcelain'])
    // git prints forward slashes on every platform and the recorded path is joined
    // the host's way, so only the canonical form compares.
    expect(listed).toContain(canonicalPath(ready.path))

    expect(seen.map((event) => event.type)).toEqual(['worktree.created', 'worktree.updated'])
    const last = seen.at(-1)
    expect(last?.type === 'worktree.updated' && last.worktree.state).toBe('ready')
  })

  it('dedupes the branch name against existing branches and other worktrees', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    await repo.git(['branch', 'fix-login'])

    const first = await readyWorktree(service, project.id, 'Fix login')
    const second = await readyWorktree(service, project.id, 'fix  LOGIN!!')

    expect(first.branch).toBe('fix-login-2')
    expect(second.branch).toBe('fix-login-3')
    expect(first.path).not.toBe(second.path)
    expect(existsSync(second.path)).toBe(true)
  })

  it('refuses an explicit branch name that is already taken', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const error = await rejection(service.createWorktree({ projectId: project.id, name: 'x', branch: 'main' }))

    expect(error.code).toBe(ErrorCode.Conflict)
  })

  it('fails the worktree instead of the call when the start ref does not exist', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const pending = await service.createWorktree({
      projectId: project.id,
      name: 'doomed',
      startedFrom: 'origin/does-not-exist'
    })
    expect(pending.state).toBe('creating')

    const settled = await service.whenSettled(pending.id)
    expect(settled.state).toBe('failed')
    expect(settled.error).toContain('origin/does-not-exist')
    expect(settled.retryable).toBeUndefined()

    // The row survives so the UI can offer a retry, but nothing was left behind.
    expect(await service.listWorktrees({})).toHaveLength(1)
    expect(existsSync(settled.path)).toBe(false)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('doomed')
  })

  it('cancels a create in flight and cleans up after it', async () => {
    const repo = await newRepo()
    const service = newService(repo, {
      runner: createDelayedRunner(createGitRunner(), (args) => args[0] === 'worktree' && args[1] === 'add', 150)
    })
    const project = await service.addProject({ path: repo.repoPath })

    const pending = await service.createWorktree({ projectId: project.id, name: 'never mind' })
    const settled = await service.cancelWorktreeCreate(pending.id)

    expect(settled?.state).toBe('failed')
    expect(settled?.error).toBe('creation cancelled')
    expect(settled?.retryable).toBe(true)
    expect(existsSync(pending.path)).toBe(false)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('never-mind')
  })

  // The record keeps both task and name, so a pane can be told again and a listing can say why.
  it('keeps the task on the record, and leaves it off a record made without one', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    const told = await service.createWorktree({
      projectId: project.id,
      name: 'Make the pager stream',
      task: 'Make the pager stream\n\nIt buffers the whole file today.'
    })
    expect(told.task).toBe('Make the pager stream\n\nIt buffers the whole file today.')
    expect((await service.whenSettled(told.id)).task).toBe(told.task)
    const listed = await service.listWorktrees({ projectId: project.id })
    expect(listed.find((worktree) => worktree.id === told.id)?.task).toBe(told.task)

    const bare = await service.createWorktree({ projectId: project.id, name: 'a checkout' })
    expect('task' in bare).toBe(false)
  })
})

describe('worktree.rename', () => {
  it('changes the name and nothing else', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const pending = await service.createWorktree({ projectId: project.id, name: 'pager claude', task: 'Fix the pager' })
    const before = await service.whenSettled(pending.id)
    const seen: GitEvent[] = []
    service.events.on((event) => seen.push(event))

    const renamed = await service.renameWorktree({ worktreeId: before.id, name: '  the winner  ' })

    expect(renamed).toEqual({ ...before, name: 'the winner' })
    expect((await service.getWorktree({ worktreeId: before.id })).name).toBe('the winner')
    expect(seen).toEqual([{ type: 'worktree.updated', worktree: renamed }])
  })

  it('refuses a blank name and an unknown worktree', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'keep me')

    expect((await rejection(service.renameWorktree({ worktreeId: worktree.id, name: '   ' }))).code).toBe(
      ErrorCode.InvalidParams
    )
    expect((await rejection(service.renameWorktree({ worktreeId: 'nope', name: 'x' }))).code).toBe(ErrorCode.NotFound)
    expect((await service.getWorktree({ worktreeId: worktree.id })).name).toBe('keep me')
  })

  it('keeps a name given while the checkout is still being built', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const pending = await service.createWorktree({ projectId: project.id, name: 'early' })

    await service.renameWorktree({ worktreeId: pending.id, name: 'renamed early' })
    const settled = await service.whenSettled(pending.id)

    expect(settled.state).toBe('ready')
    expect(settled.name).toBe('renamed early')
    expect(settled.branch).toBe('early')
  })
})

describe('worktree.remove', () => {
  it('removes the checkout and the branch', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'short lived')

    expect(await service.removeWorktree({ worktreeId: worktree.id, deleteBranch: true })).toEqual({ removed: true })

    expect(existsSync(worktree.path)).toBe(false)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('short-lived')
    expect((await rejection(service.getWorktree({ worktreeId: worktree.id }))).code).toBe(ErrorCode.NotFound)
  })

  it('refuses to delete a branch with unmerged commits unless force is set', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'real work')
    await repo.write('feature.txt', 'work\n', worktree.path)
    await repo.commit('add a feature', worktree.path)

    const error = await rejection(service.removeWorktree({ worktreeId: worktree.id, deleteBranch: true }))
    expect(error.code).toBe(ErrorCode.Conflict)
    expect(error.message).toContain('not in main')

    // Refusal is total: nothing was removed on the way to saying no.
    expect(existsSync(worktree.path)).toBe(true)
    expect((await service.getWorktree({ worktreeId: worktree.id })).state).toBe('ready')

    await service.removeWorktree({ worktreeId: worktree.id, deleteBranch: true, force: true })
    expect(existsSync(worktree.path)).toBe(false)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('real-work')
  })

  // `~/.teamree/worktrees/<project>` is made for the first checkout; it must not
  // outlive the last as an empty folder per project ever tracked.
  it('takes the project’s directory with the last checkout, and only then', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const first = await readyWorktree(service, project.id, 'first')
    const second = await readyWorktree(service, project.id, 'second')
    const projectDir = path.dirname(first.path)
    expect(path.dirname(projectDir)).toBe(repo.worktreesRoot)
    expect(path.dirname(second.path)).toBe(projectDir)

    await service.removeWorktree({ worktreeId: first.id, deleteBranch: true })
    expect(existsSync(projectDir)).toBe(true)

    await service.removeWorktree({ worktreeId: second.id, deleteBranch: true })
    expect(existsSync(projectDir)).toBe(false)
    expect(existsSync(repo.worktreesRoot)).toBe(true)
  })

  it('leaves the project’s directory alone while anything else is in it', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const only = await readyWorktree(service, project.id, 'only')
    const projectDir = path.dirname(only.path)
    await mkdir(path.join(projectDir, 'notes'), { recursive: true })

    await service.removeWorktree({ worktreeId: only.id, deleteBranch: true })

    expect(existsSync(only.path)).toBe(false)
    expect(existsSync(path.join(projectDir, 'notes'))).toBe(true)
  })

  it('keeps the branch when only the checkout is removed', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'keep branch')

    await service.removeWorktree({ worktreeId: worktree.id })

    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).toContain('keep-branch')
  })
})

describe('reconciliation', () => {
  it('drops worktrees that were removed outside the app', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const survivor = await readyWorktree(service, project.id, 'survivor')
    const doomed = await readyWorktree(service, project.id, 'doomed')

    await rm(doomed.path, { recursive: true, force: true })
    await repo.git(['worktree', 'prune'])

    const removed: string[] = []
    service.events.on((event) => {
      if (event.type === 'worktree.removed') removed.push(event.worktreeId)
    })

    const listed = await service.listWorktrees({ projectId: project.id })

    expect(listed.map((worktree) => worktree.id)).toEqual([survivor.id])
    expect(removed).toEqual([doomed.id])
  })
})

// A record whose directory is gone but whose git metadata is not (an `rm -rf`
// of a checkout). The inventory still lists it, so the row used to say `ready`.
describe('a worktree whose directory has gone', () => {
  async function missingWorktree(): Promise<{ repo: TempRepo; service: GitService; worktree: Worktree }> {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'gone')
    await rm(worktree.path, { recursive: true, force: true })
    return { repo, service, worktree }
  }

  it('is listed as missing rather than ready', async () => {
    const { service, worktree } = await missingWorktree()
    const [listed] = await service.listWorktrees({ projectId: worktree.projectId })
    expect(listed?.state).toBe('ready')
    expect(listed?.missing).toBe(true)
  })

  it('says so on the change stream, once', async () => {
    const { service, worktree } = await missingWorktree()
    const updated: Worktree[] = []
    service.events.on((event) => {
      if (event.type === 'worktree.updated') updated.push(event.worktree)
    })
    await service.listWorktrees({})
    await service.listWorktrees({})
    expect(updated.map((row) => [row.id, row.missing])).toEqual([[worktree.id, true]])
  })

  it('stops being missing when the directory is back', async () => {
    const { service, worktree } = await missingWorktree()
    await service.listWorktrees({})
    await mkdir(worktree.path, { recursive: true })
    const [listed] = await service.listWorktrees({ projectId: worktree.projectId })
    expect(listed?.missing).toBeUndefined()
  })

  it('answers status without throwing, and says the checkout is missing', async () => {
    const { service, worktree } = await missingWorktree()
    const status = await service.worktreeStatus({ worktreeId: worktree.id })
    expect(status.missing).toBe(true)
    expect(status.branch).toBe(worktree.branch)
    expect(status.staged + status.unstaged + status.untracked + status.conflicted).toBe(0)
  })

  it('can be removed, which prunes what git still knew about it', async () => {
    const { repo, service, worktree } = await missingWorktree()
    await service.listWorktrees({})

    expect(await service.removeWorktree({ worktreeId: worktree.id, deleteBranch: true })).toEqual({ removed: true })

    expect((await rejection(service.getWorktree({ worktreeId: worktree.id }))).code).toBe(ErrorCode.NotFound)
    const inventory = await repo.git(['worktree', 'list', '--porcelain'])
    expect(inventory).not.toContain(worktree.path)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('gone')
  })
})

describe('persistence', () => {
  it('marks creates that a restart interrupted as failed', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    service.hydrate({
      projects: [{ id: 'p1', name: 'repo', path: repo.repoPath, baseRef: 'main' }],
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'half built',
          branch: 'half-built',
          path: path.join(repo.worktreesRoot, 'repo', 'half-built'),
          startedFrom: 'main',
          state: 'creating',
          createdAt: 1
        }
      ]
    })

    const [restored] = await service.listWorktrees({})
    expect(restored?.state).toBe('failed')
    expect(restored?.error).toContain('restart')
  })
})

describe('handler seam', () => {
  it('exposes the contract methods as plain functions', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const handlers = createGitHandlers(service)

    const project = await handlers['project.add']({ path: repo.repoPath })
    expect(await handlers['project.list']({})).toEqual([project])

    const created = await handlers['worktree.create']({ projectId: project.id, name: 'via handlers' })
    await service.whenSettled(created.id)
    const fetched = await handlers['worktree.get']({ worktreeId: created.id })
    expect(fetched.state).toBe('ready')

    const status = await handlers['worktree.status']({ worktreeId: created.id })
    expect(status.worktreeId).toBe(created.id)
    expect(status.branch).toBe('via-handlers')

    expect((await handlers['worktree.rename']({ worktreeId: created.id, name: 'renamed' })).name).toBe('renamed')

    expect(await handlers['worktree.remove']({ worktreeId: created.id })).toEqual({ removed: true })
    expect(await handlers['project.remove']({ projectId: project.id })).toEqual({ removed: true })
  })

  it('hands an untracked file to the Trash it was given, and refuses one without', async () => {
    const repo = await newRepo()
    const trashed: string[] = []
    const service = newService(repo, { trash: async (target) => void trashed.push(target) })
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'discard')
    await repo.write('new.txt', 'x\n', worktree.path)

    const handlers = createGitHandlers(service)
    const result = await handlers['worktree.discardPath']({ worktreeId: worktree.id, path: 'new.txt' })

    expect(result.outcome).toBe('trashed')
    expect(trashed).toEqual([path.join(worktree.path, 'new.txt')])
    const bare = newService(repo)
    const again = await bare.addProject({ path: repo.repoPath })
    const other = await readyWorktree(bare, again.id, 'no trash')
    await repo.write('new.txt', 'x\n', other.path)
    expect((await rejection(bare.worktreeDiscardPath({ worktreeId: other.id, path: 'new.txt' }))).code).toBe(
      ErrorCode.Conflict
    )
    expect(existsSync(path.join(other.path, 'new.txt'))).toBe(true)
  })
})

describe('the command a project runs in every new worktree', () => {
  /** A `startSetup` that records rather than opening anything. */
  function recorder(): { startSetup: GitServiceOptions['startSetup']; runs: Array<{ id: string; command: string }> } {
    const runs: Array<{ id: string; command: string }> = []
    return {
      runs,
      startSetup: ({ worktree, command }) => {
        runs.push({ id: worktree.id, command })
        return `t_setup_${runs.length}`
      }
    }
  }

  it('stores the command, trims it, and clears it with an empty string', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })

    expect(project.setupCommand).toBeUndefined()

    const set = await service.setProjectPaths({ projectId: project.id, setupCommand: '  npm ci  ' })
    expect(set.setupCommand).toBe('npm ci')
    expect(service.listProjects()[0]?.setupCommand).toBe('npm ci')

    // An omitted field leaves the stored one alone, the way an omitted list does.
    const untouched = await service.setProjectPaths({ projectId: project.id, linkedPaths: [] })
    expect(untouched.setupCommand).toBe('npm ci')

    // Absent rather than empty: "" and "never configured" must not both be storable.
    const cleared = await service.setProjectPaths({ projectId: project.id, setupCommand: '' })
    expect('setupCommand' in cleared).toBe(false)
  })

  it('runs it once the checkout is ready, and records the pane on the worktree', async () => {
    const repo = await newRepo()
    const { startSetup, runs } = recorder()
    const service = newService(repo, { startSetup })
    const project = await service.addProject({ path: repo.repoPath })
    await service.setProjectPaths({ projectId: project.id, setupCommand: 'npm ci' })

    const worktree = await readyWorktree(service, project.id, 'runs setup')

    expect(runs).toEqual([{ id: worktree.id, command: 'npm ci' }])
    expect(worktree.setupTerminalId).toBe('t_setup_1')
    // On the stored record too, so a later read answers the same thing.
    expect((await service.getWorktree({ worktreeId: worktree.id })).setupTerminalId).toBe('t_setup_1')
  })

  it('runs it for every worktree of a fan-out, each in its own', async () => {
    const repo = await newRepo()
    const { startSetup, runs } = recorder()
    const service = newService(repo, { startSetup })
    const project = await service.addProject({ path: repo.repoPath })
    await service.setProjectPaths({ projectId: project.id, setupCommand: 'npm ci' })

    const first = await readyWorktree(service, project.id, 'attempt one')
    const second = await readyWorktree(service, project.id, 'attempt two')

    expect(runs.map((run) => run.id).sort()).toEqual([first.id, second.id].sort())
    expect(first.setupTerminalId).not.toBe(second.setupTerminalId)
  })

  // A project that has said nothing must get exactly the panes it used to get: none.
  it('opens nothing for a project that named no command', async () => {
    const repo = await newRepo()
    const { startSetup, runs } = recorder()
    const service = newService(repo, { startSetup })
    const project = await service.addProject({ path: repo.repoPath })

    const worktree = await readyWorktree(service, project.id, 'no setup')

    expect(runs).toEqual([])
    expect(worktree.setupTerminalId).toBeUndefined()
  })

  it('reads the command as it stands when the checkout finishes, not as it stood when create was called', async () => {
    const repo = await newRepo()
    const { startSetup, runs } = recorder()
    const service = newService(repo, { startSetup })
    const project = await service.addProject({ path: repo.repoPath })
    await service.setProjectPaths({ projectId: project.id, setupCommand: 'npm ci' })

    const pending = await service.createWorktree({ projectId: project.id, name: 'late edit' })
    await service.setProjectPaths({ projectId: project.id, setupCommand: 'npm ci --offline' })
    await service.whenSettled(pending.id)

    expect(runs.map((run) => run.command)).toEqual(['npm ci --offline'])
  })

  // A machine that cannot fork a pty must not lose a good checkout: the worktree
  // is ready, and the absent id says setup did not start.
  it('keeps the worktree when the pane cannot be opened', async () => {
    const repo = await newRepo()
    const service = newService(repo, {
      startSetup: () => {
        throw new Error('no pty here')
      }
    })
    const project = await service.addProject({ path: repo.repoPath })
    await service.setProjectPaths({ projectId: project.id, setupCommand: 'npm ci' })

    const worktree = await readyWorktree(service, project.id, 'no pty')

    expect(worktree.state).toBe('ready')
    expect(worktree.setupTerminalId).toBeUndefined()
  })
})
