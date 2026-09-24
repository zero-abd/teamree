// The destructive paths, held to two rules: "I could not tell" must never become
// "it was not there", and a cleanup after a failed create owns only what that
// create made. Real GitService against a real repository throughout.

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

/** Records every command and lets a test interfere with named ones. */
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
    // Named: "2 ignored files" cannot tell a rebuildable node_modules from the only .env.
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

    expect(await service.removeWorktree({ worktreeId: worktree.id })).toEqual({
      removed: true,
      trashId: expect.any(String)
    })
    expect(existsSync(worktree.path)).toBe(false)
  })

  it('still removes a checkout git can no longer read rather than holding the row hostage', async () => {
    const repo = await newRepo()
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'broken checkout')
    await repo.write('notes.md', 'the only copy\n', worktree.path)
    // Whatever is left here, `git worktree remove` will not delete it either.
    await rm(path.join(worktree.path, '.git'), { recursive: true, force: true })

    const result = await service.removeWorktree({ worktreeId: worktree.id })
    expect(result.removed).toBe(true)

    // The row going is the whole of what happened: `git worktree remove` refused to
    // read the directory, so every file is still there and this is the last chance to say where.
    expect(existsSync(path.join(worktree.path, 'notes.md'))).toBe(true)
    expect(result.checkoutLeftAt).toBe(worktree.path)
  })

  it('deletes the ignored files once that has been forced', async () => {
    const repo = await newRepo()
    await repo.write('.gitignore', '.env\n')
    await repo.commit('ignore the local-only files')
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'agent two')
    await repo.write('.env', 'API_KEY=hunter2\n', worktree.path)

    expect(await service.removeWorktree({ worktreeId: worktree.id, force: true })).toEqual({
      removed: true,
      trashId: expect.any(String)
    })
    expect(existsSync(worktree.path)).toBe(false)
  })
})

describe("the user's own git configuration", () => {
  // `status.showUntrackedFiles=no` is set in ~/.gitconfig for a large repository and
  // covers every repository that person owns. An unforced removal leans on `git
  // worktree remove` refusing a dirty checkout, and git decides dirty with a status that obeys it.
  it('refuses an unforced removal over untracked work even when status is configured to hide it', async () => {
    const repo = await newRepo()
    await repo.git(['config', 'status.showUntrackedFiles', 'no'])
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'agent one')
    await repo.write('notes.md', 'an afternoon of work\n', worktree.path)

    const error = await rejection(service.removeWorktree({ worktreeId: worktree.id }))
    expect(error.code).toBe(ErrorCode.Conflict)
    expect(existsSync(path.join(worktree.path, 'notes.md'))).toBe(true)
    expect((await service.getWorktree({ worktreeId: worktree.id })).state).toBe('ready')
  })

  it('shows the same untracked file in the changes panel that the status chip counts', async () => {
    const repo = await newRepo()
    await repo.git(['config', 'status.showUntrackedFiles', 'no'])
    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await readyWorktree(service, project.id, 'agent one')
    await repo.write('notes.md', 'an afternoon of work\n', worktree.path)

    // The chip pins the flag and the panel did not: "1 untracked" beside a panel showing nothing.
    expect((await service.worktreeStatus({ worktreeId: worktree.id })).untracked).toBe(1)
    const changes = await service.worktreeChanges({ worktreeId: worktree.id })
    expect(changes.changes.map((change) => change.path)).toEqual(['notes.md'])
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

    // Nothing destroyed, nothing forgotten: the row is still the only way back to the files.
    expect(commands.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
    expect(existsSync(path.join(worktree.path, 'feature.txt'))).toBe(true)
    expect((await service.getWorktree({ worktreeId: worktree.id })).state).toBe('ready')
  })
})

describe('cleaning up after a failed create', () => {
  it('leaves a branch it did not create alone when the checkout fails', async () => {
    const repo = await newRepo()
    // A commit main does not have, parked so the same sha can be handed to the branch in the way.
    await repo.git(['checkout', '-b', 'spare'])
    await repo.write('login.ts', 'export const login = true\n')
    await repo.commit("the user's afternoon")
    const parked = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['checkout', 'main'])

    const commands: string[][] = []
    const service = newService(repo, {
      runner: createProbeRunner(createGitRunner(), commands, async (args) => {
        // Someone else claims the name between the collision check and the add; the
        // add then fails for a branch this create never made.
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
          // The add is what makes the branch, so failing straight after it is the case the cleanup exists for.
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

describe('two creates racing for one checkout path', () => {
  // `#chooseBranch` and `allocateCheckoutPath` both read the store before the record
  // is written, so two overlapping creates agree on one slug and name one directory.
  // Whichever `worktree add` loses then cleans up over the winner's checkout.
  it('gives them different checkouts instead of letting the loser delete the winner', async () => {
    const repo = await newRepo()
    const inner = createGitRunner()

    // Puts the two creates inside the window together. Times out rather than
    // deadlocks, so a serialised pair that never meets carries on.
    let waiting: (() => void) | null = null
    const meetInTheWindow = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (waiting) {
          const other = waiting
          waiting = null
          other()
          resolve()
          return
        }
        waiting = resolve
        setTimeout(() => {
          if (waiting === resolve) {
            waiting = null
            resolve()
          }
        }, 500)
      })

    let adds = 0
    const service = newService(repo, {
      runner: {
        binary: inner.binary,
        async run(run) {
          // The listing `#chooseBranch` waits on, and nothing else.
          if (run.args[0] === 'for-each-ref' && run.args[1] === '--format=%(refname:short)') {
            await meetInTheWindow()
          }
          // The loser then sits there while the winner finishes and is used.
          if (run.args[0] === 'worktree' && run.args[1] === 'add') {
            adds += 1
            if (adds === 2) await new Promise((resolve) => setTimeout(resolve, 1_000))
          }
          return inner.run(run)
        },
        tryRun: (run) => inner.tryRun(run)
      }
    })
    const project = await service.addProject({ path: repo.repoPath })

    const [first, second] = await Promise.all([
      service.createWorktree({ projectId: project.id, name: 'fix login' }),
      service.createWorktree({ projectId: project.id, name: 'fix login' })
    ])
    // One task, one checkout.
    expect(first.path).not.toBe(second.path)
    expect(first.branch).not.toBe(second.branch)

    const winner = await service.whenSettled(first.id)
    expect(winner.state).toBe('ready')
    // An agent's afternoon, committed, in the checkout the app said was ready.
    await repo.write('login.ts', 'export const login = true\n', winner.path)
    await repo.commit('an afternoon of it', winner.path)
    const commit = await repo.git(['rev-parse', 'HEAD'], winner.path)

    expect((await service.whenSettled(second.id)).state).toBe('ready')
    // Long enough for the other create's cleanup to have run, had it wanted to.
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(existsSync(path.join(winner.path, 'login.ts'))).toBe(true)
    expect(await repo.git(['rev-parse', 'HEAD'], winner.path)).toBe(commit)
    // And the row is still in the sidebar, pointing at it.
    expect((await service.getWorktree({ worktreeId: first.id })).state).toBe('ready')
  })

  it('touches nothing at its checkout path when it failed before ever asking for one', async () => {
    const repo = await newRepo()
    const commands: string[][] = []
    const service = newService(repo, {
      runner: createProbeRunner(createGitRunner(), commands, () => {})
    })
    const project = await service.addProject({ path: repo.repoPath })

    // Fails while resolving the start point, which is before `worktree add`.
    const pending = await service.createWorktree({
      projectId: project.id,
      name: 'fix login',
      startedFrom: 'no-such-ref'
    })
    expect((await service.whenSettled(pending.id)).state).toBe('failed')

    // Nothing was put at that path, so nothing there is this create's to undo: a path
    // another record may hold, and `worktree remove --force` would unregister a live checkout.
    const destructive = commands.filter(
      (args) => args[0] === 'worktree' && (args[1] === 'remove' || args[1] === 'prune')
    )
    expect(destructive).toEqual([])
  })
})

describe('deleting the branch along with the worktree', () => {
  // `#judgeBranchDeletion` asks whether the branch is an ancestor of the base ref;
  // `git branch -d` asks whether it is merged into HEAD or upstream. The second was
  // asked after the checkout was destroyed, so the failure read as "nothing happened".
  it('acts on the proof it already has instead of refusing after the checkout is gone', async () => {
    const repo = await createTempRepo({ withRemote: true })
    repos.push(repo)
    // A branch for the primary checkout to sit on, older than what was pushed.
    await repo.git(['branch', 'old'])
    await repo.write('shipped.ts', 'export const shipped = true\n')
    await repo.commit('a commit origin/main has and old does not')
    await repo.git(['push', 'origin', 'main'])
    await repo.git(['checkout', 'old'])

    const service = newService(repo)
    const project = await service.addProject({ path: repo.repoPath })
    expect(project.baseRef).toBe('origin/main')
    const pending = await service.createWorktree({ projectId: project.id, name: 'fix login', startedFrom: 'main' })
    const worktree = await service.whenSettled(pending.id)
    expect(worktree.state).toBe('ready')

    const result = await service.removeWorktree({ worktreeId: worktree.id, deleteBranch: true })

    expect(result.removed).toBe(true)
    expect(existsSync(worktree.path)).toBe(false)
    // Every commit on it is in origin/main, which is what made the removal safe to start.
    await expect(repo.git(['rev-parse', '--verify', worktree.branch])).rejects.toThrow()
  })
})
