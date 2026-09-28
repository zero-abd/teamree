// A project added again finds the checkouts teamree made for it: a lost workspace file must not strand them.

import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

function service(repo: TempRepo): GitService {
  const made = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(made)
  return made
}

/** Three tasks made by one run of the app, whose records are then lost. */
async function strandedTasks(): Promise<TempRepo> {
  const repo = await createTempRepo()
  repos.push(repo)
  const first = service(repo)
  const project = await first.addProject({ path: repo.repoPath })
  for (const name of ['add a readme', 'fix login', 'tidy css']) {
    const made = await first.whenSettled((await first.createWorktree({ projectId: project.id, name })).id)
    expect(made.state).toBe('ready')
  }
  await repo.write('notes.md', 'work in progress\n', path.join(repo.worktreesRoot, 'repo', 'fix-login'))
  return repo
}

describe('adding a project whose worktrees are already on disk', () => {
  it('takes them back as tasks, work and all', async () => {
    const repo = await strandedTasks()
    const again = service(repo)

    const project = await again.addProject({ path: repo.repoPath })
    const tasks = await again.listWorktrees({ projectId: project.id })

    expect(tasks.map((task) => [task.name, task.branch, task.state]).sort()).toEqual([
      ['add a readme', 'add-a-readme', 'ready'],
      ['fix login', 'fix-login', 'ready'],
      ['tidy css', 'tidy-css', 'ready']
    ])
    const fixLogin = tasks.find((task) => task.branch === 'fix-login')
    const changes = await again.worktreeChanges({ worktreeId: fixLogin?.id ?? '' })
    expect(changes.changes.map((change) => change.path)).toEqual(['notes.md'])
  })

  it('leaves checkouts outside the worktrees folder to Open Branch', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const elsewhere = path.join(repo.base, 'mine')
    await repo.git(['worktree', 'add', '-b', 'by-hand', elsewhere])

    const again = service(repo)
    const project = await again.addProject({ path: repo.repoPath })

    expect(await again.listWorktrees({ projectId: project.id })).toEqual([])
    const branches = await again.listBranches({ projectId: project.id })
    expect(branches.branches.map((branch) => branch.name)).toContain('by-hand')
  })
})
