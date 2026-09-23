import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    // Canonically: a project's path is stored resolved and with its separators
    // normalised, which on Windows is not the string that was handed in.
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
    expect(service.listProjects()).toEqual([])
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
    // git prints forward slashes on every platform, and a worktree's recorded
    // path is joined the host's way — so on Windows these are the same place
    // spelled two ways, and only the canonical form compares.
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
    expect(existsSync(pending.path)).toBe(false)
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('never-mind')
  })

  // The task is what the checkout is for, and the name is only what it is
  // called: the record keeps both, so a pane started over in it can be told
  // again, and a listing can say what each row was opened to do.
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

    expect(await handlers['worktree.remove']({ worktreeId: created.id })).toEqual({ removed: true })
    expect(await handlers['project.remove']({ projectId: project.id })).toEqual({ removed: true })
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

  // The regression guard. A project that has said nothing must get exactly the
  // panes it used to get, which is none.
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

  // A machine that cannot fork a pty must not lose a good checkout over a
  // convenience: the worktree is ready, and the absent id says setup did not
  // start.
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
