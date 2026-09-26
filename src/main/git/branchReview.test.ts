// The whole task against its base: committed and uncommitted work together, from where the branch left it.

import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function setup(): Promise<{ repo: TempRepo; service: GitService; project: Project }> {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.write('README.md', 'A small API servce.\n')
  await repo.write('src/app.ts', 'export const app = 1\n')
  await repo.commit('initial')
  const service = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, project }
}

async function ready(service: GitService, params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const settled = await service.whenSettled((await service.createWorktree(params)).id)
  if (settled.state !== 'ready') throw new Error(`"${params.name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

describe('a branch review', () => {
  it('shows one commit and one dirty file together, and not what the base did since', async () => {
    const { repo, service, project } = await setup()
    const task = await ready(service, { projectId: project.id, name: 'fix typo' })
    await repo.write('README.md', 'A small API service.\n', task.path)
    await repo.commit('Fix README typo', task.path)
    await repo.write('src/app.ts', 'export const app = 2\n', task.path)
    await repo.write('notes.md', 'one\ntwo\n', task.path)
    await repo.write('LICENSE', 'moved on\n')
    await repo.commit('main moved on')

    const diff = await service.worktreeDiff({ worktreeId: task.id, base: true })
    expect(diff.patch).toContain('+A small API service.')
    expect(diff.patch).toContain('+export const app = 2')
    expect(diff.patch).toContain('+++ b/notes.md')
    expect(diff.patch).not.toContain('LICENSE')

    const uncommitted = await service.worktreeDiff({ worktreeId: task.id, head: true })
    expect(uncommitted.patch).not.toContain('README.md')

    const files = await service.worktreeChanges({ worktreeId: task.id, base: true })
    expect(files.changes.map((change) => [change.path, change.kind, change.added, change.removed])).toEqual([
      ['README.md', 'modified', 1, 1],
      ['src/app.ts', 'modified', 1, 1],
      ['notes.md', 'untracked', 2, 0]
    ])
    expect(files.total).toBe(3)
  })

  it('lists the committed work once everything is committed', async () => {
    const { repo, service, project } = await setup()
    const task = await ready(service, { projectId: project.id, name: 'fix typo' })
    await repo.write('README.md', 'A small API service.\n', task.path)
    await repo.commit('Fix README typo', task.path)

    expect((await service.worktreeChanges({ worktreeId: task.id })).changes).toEqual([])
    const files = await service.worktreeChanges({ worktreeId: task.id, base: true })
    expect(files.changes.map((change) => change.path)).toEqual(['README.md'])
    const one = await service.worktreeDiff({ worktreeId: task.id, base: true, path: 'README.md' })
    expect(one.patch).toContain('-A small API servce.')
  })

  it('measures a child against its parent branch, not the project base', async () => {
    const { repo, service, project } = await setup()
    const parent = await ready(service, { projectId: project.id, name: 'rate limits' })
    await repo.write('limits.ts', 'parent\n', parent.path)
    await repo.commit('parent work', parent.path)
    const child = await ready(service, { projectId: project.id, name: 'tests', parentId: parent.id })
    await repo.write('limits.test.ts', 'child\n', child.path)
    await repo.commit('child work', child.path)

    const files = await service.worktreeChanges({ worktreeId: child.id, base: true })
    expect(files.changes.map((change) => change.path)).toEqual(['limits.test.ts'])
  })

  it('reads a rename and a deletion by what they are', async () => {
    const { repo, service, project } = await setup()
    const task = await ready(service, { projectId: project.id, name: 'move' })
    await repo.git(['mv', 'src/app.ts', 'src/main.ts'], task.path)
    await repo.git(['rm', '-q', 'README.md'], task.path)
    await repo.commit('move and drop', task.path)

    const files = await service.worktreeChanges({ worktreeId: task.id, base: true })
    expect(files.changes.map((change) => [change.path, change.kind, change.from])).toEqual([
      ['README.md', 'deleted', undefined],
      ['src/main.ts', 'renamed', 'src/app.ts']
    ])
  })
})
