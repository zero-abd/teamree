// The destructive paths, held to the two rules they were found breaking.
//
// "I could not tell" must never become "it was not there": a read that fails
// is not permission to destroy or to forget. And "only undo what you did": a
// cleanup after a failed create owns what that create made, and nothing else.
//
// Every test drives the real GitService against a real repository, because the
// bugs below were all cases where our idea of git and git differed.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { createGitRunner, type GitRunner } from './gitProcess'
import { GitService, type GitServiceOptions } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function newRepo(): Promise<TempRepo> {
  const repo = await createTempRepo()
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

type Interceptor = (args: readonly string[]) => Promise<void> | void

/**
 * Records every command and lets a test interfere with named ones — the only
 * way to reach "git answered, but not the way you assumed" deterministically.
 */
function createProbeRunner(inner: GitRunner, commands: string[][], intercept: Interceptor): GitRunner {
  return {
    binary: inner.binary,
    async run(run) {
      commands.push([...run.args])
      await intercept(run.args)
      return inner.run(run)
    },
    async tryRun(run) {
      commands.push([...run.args])
      await intercept(run.args)
      return inner.tryRun(run)
    }
  }
}

describe('ignored files a removal would delete', () => {
  it('refuses to remove a worktree holding ignored files rather than deleting them silently', async () => {
    const repo = await newRepo()
    await repo.write('.gitignore', '.env\nnode_modules/\n')
    await repo.commit('ignore the local-only files')
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'agent one')
    await repo.write('.env', 'API_KEY=hunter2\n', worktree.path)
    await repo.write('node_modules/left-pad/index.js', 'module.exports = 1\n', worktree.path)

    // Git's own idea of dirty is modified-or-untracked, so it sees nothing here.
    const status = await service.worktreeStatus({ worktreeId: worktree.id })
    expect(status.staged + status.unstaged + status.untracked + status.conflicted).toBe(0)
    // The app knows more than git does, and the row can say so.
    expect(status.ignored).toBe(2)

    const error = await rejection(service.removeWorktree({ worktreeId: worktree.id }))
    expect(error.code).toBe(ErrorCode.Conflict)
    // Named, because "2 ignored files" cannot tell a rebuildable node_modules
    // from the only copy of a .env, and the person can.
    expect(error.message).toContain('.env')

    expect(existsSync(path.join(worktree.path, '.env'))).toBe(true)
    expect((await service.getWorktree({ worktreeId: worktree.id })).state).toBe('ready')
  })

  it('removes a worktree with nothing ignored in it without stopping to ask', async () => {
    const repo = await newRepo()
    await repo.write('.gitignore', '.env\n')
    await repo.commit('ignore the local-only files')
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'nothing to lose')

    expect(await service.removeWorktree({ worktreeId: worktree.id })).toEqual({ removed: true })
    expect(existsSync(worktree.path)).toBe(false)
  })

  it('still removes a checkout git can no longer read rather than holding the row hostage', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'broken checkout')
    // Whatever is left here, `git worktree remove` will not delete it either.
    await rm(path.join(worktree.path, '.git'), { recursive: true, force: true })

    expect(await service.removeWorktree({ worktreeId: worktree.id })).toEqual({ removed: true })
  })

  it('deletes the ignored files once that has been forced', async () => {
    const repo = await newRepo()
    await repo.write('.gitignore', '.env\n')
    await repo.commit('ignore the local-only files')
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'agent two')
    await repo.write('.env', 'API_KEY=hunter2\n', worktree.path)

    expect(await service.removeWorktree({ worktreeId: worktree.id, force: true })).toEqual({ removed: true })
    expect(existsSync(worktree.path)).toBe(false)
  })
})

describe('a repository git cannot be asked about', () => {
  it('refuses to remove a worktree it cannot look up rather than reporting it removed', async () => {
    const repo = await newRepo()
    const commands: string[][] = []
    let listFails = false
    const service = newService(repo, {
      runner: createProbeRunner(createGitRunner(), commands, (args) => {
        if (listFails && args[0] === 'worktree' && args[1] === 'list') {
          throw new Error('git: could not read the repository')
        }
      })
    })
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'real work')
    await repo.write('feature.txt', 'an afternoon of it\n', worktree.path)

    listFails = true
    commands.length = 0
    await expect(service.removeWorktree({ worktreeId: worktree.id })).rejects.toThrow()

    // Nothing was destroyed, and nothing was forgotten: the row is still there
    // with the project it belongs to, which is the only way back to the files.
    expect(commands.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
    expect(existsSync(path.join(worktree.path, 'feature.txt'))).toBe(true)
    expect((await service.getWorktree({ worktreeId: worktree.id })).state).toBe('ready')
  })
})

describe('cleaning up after a failed create', () => {
  it('leaves a branch it did not create alone when the checkout fails', async () => {
    const repo = await newRepo()
    // A commit the user has and main does not, parked on a branch of its own so
    // the test can hand the same sha to the branch that gets in the way.
    await repo.git(['checkout', '-b', 'spare'])
    await repo.write('login.ts', 'export const login = true\n')
    await repo.commit("the user's afternoon")
    const parked = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['checkout', 'main'])

    const commands: string[][] = []
    const service = newService(repo, {
      runner: createProbeRunner(createGitRunner(), commands, async (args) => {
        // Someone else claims the name in the window between the collision
        // check and the add: another pane, the CLI, a hook. The add then fails
        // for a branch this create never made.
        if (args[0] === 'worktree' && args[1] === 'add') await repo.git(['branch', 'fix-login', parked])
      })
    })
    const project = await service.addProject({ path: repo.repoPath })

    const pending = await service.createWorktree({ projectId: project.id, name: 'fix login', branch: 'fix-login' })
    const settled = await service.whenSettled(pending.id)

    expect(settled.state).toBe('failed')
    expect(await repo.git(['rev-parse', 'fix-login'])).toBe(parked)
  })

  it('still deletes the branch its own failed create made', async () => {
    const repo = await newRepo()
    const inner = createGitRunner()
    const service = newService(repo, {
      runner: {
        binary: inner.binary,
        async run(run) {
          const result = await inner.run(run)
          // The add itself is what makes the branch, so failing straight after
          // it is exactly the case the cleanup exists for.
          if (run.args[0] === 'worktree' && run.args[1] === 'add') throw new Error('the create failed after the add')
          return result
        },
        tryRun: (run) => inner.tryRun(run)
      }
    })
    const project = await service.addProject({ path: repo.repoPath })
    const pending = await service.createWorktree({ projectId: project.id, name: 'doomed' })

    expect((await service.whenSettled(pending.id)).state).toBe('failed')
    const branches = await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    expect(branches.split('\n')).not.toContain('doomed')
    expect(existsSync(pending.path)).toBe(false)
  })
})
