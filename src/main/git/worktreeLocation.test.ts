// Where new worktrees go and what their branches are called, as Settings sets them: per project,
// else this Mac's, against a real repository.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import type { RuntimeSettings } from '../../shared/settings'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function setup(settings: Partial<RuntimeSettings> = {}) {
  const repo = await createTempRepo()
  repos.push(repo)
  const machine = { ...settings }
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, settings: () => machine })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  return { repo, service, project, machine }
}

async function ready(service: GitService, params: Parameters<GitService['createWorktree']>[0]): Promise<Worktree> {
  const settled = await service.whenSettled((await service.createWorktree(params)).id)
  if (settled.state !== 'ready') throw new Error(`"${params.name}" failed: ${settled.error ?? 'unknown'}`)
  return settled
}

describe('the worktrees folder', () => {
  it('is the project folder over this Mac, over the launch default, and never moves a checkout', async () => {
    const { repo, service, project, machine } = await setup()
    const first = await ready(service, { projectId: project.id, name: 'one' })
    expect(path.dirname(path.dirname(first.path))).toBe(repo.worktreesRoot)

    machine.worktreesRoot = path.join(repo.base, 'machine')
    const second = await ready(service, { projectId: project.id, name: 'two' })
    expect(second.path.startsWith(`${machine.worktreesRoot}${path.sep}`)).toBe(true)

    const own = path.join(repo.base, 'own')
    await service.setProjectPaths({ projectId: project.id, worktreesRoot: own })
    const third = await ready(service, { projectId: project.id, name: 'three' })
    expect(third.path.startsWith(`${own}${path.sep}`)).toBe(true)

    const listed = await service.listWorktrees({ projectId: project.id })
    expect(listed.find((worktree) => worktree.id === first.id)?.path).toBe(first.path)
    expect(listed.find((worktree) => worktree.id === second.id)?.path).toBe(second.path)
  })

  it('refuses a folder inside the repository unless asked, and clears on empty', async () => {
    const { repo, service, project } = await setup()
    const inside = path.join(repo.repoPath, '.worktrees')
    const refused = await service.setProjectPaths({ projectId: project.id, worktreesRoot: inside }).catch((e) => e)
    expect(refused).toBeInstanceOf(GitServiceError)
    expect((refused as GitServiceError).data).toMatchObject({ refusal: 'insideRepository' })

    const allowed = await service.setProjectPaths({
      projectId: project.id,
      worktreesRoot: inside,
      allowInsideRepository: true
    })
    expect(allowed.worktreesRoot).toBe(inside)
    const cleared = await service.setProjectPaths({ projectId: project.id, worktreesRoot: '' })
    expect(cleared.worktreesRoot).toBeUndefined()
  })

  it('tidies the project folder under a folder set after launch, as under the default', async () => {
    const { repo, service, project, machine } = await setup()
    machine.worktreesRoot = path.join(repo.base, 'machine')
    const made = await ready(service, { projectId: project.id, name: 'gone soon' })
    await service.removeWorktree({ worktreeId: made.id, force: true })
    expect(existsSync(path.dirname(made.path))).toBe(false)
  })
})

describe('the branch prefix', () => {
  it('leads branches the runtime names, the project one over this Mac, and leaves a named branch alone', async () => {
    const { service, project, machine } = await setup({ branchPrefix: 'mac/' })
    expect((await ready(service, { projectId: project.id, name: 'Fix login' })).branch).toBe('mac/fix-login')

    await service.setProjectPaths({ projectId: project.id, branchPrefix: 'abd/' })
    const parent = await ready(service, { projectId: project.id, name: 'Rework auth' })
    expect(parent.branch).toBe('abd/rework-auth')
    const child = await ready(service, { projectId: project.id, name: 'tests', parentId: parent.id })
    expect(child.branch).toBe('abd/rework-auth--tests')
    expect(path.basename(child.path)).toBe(`${path.basename(parent.path)}--tests`)

    const named = await ready(service, { projectId: project.id, name: 'Named', branch: 'exact-name' })
    expect(named.branch).toBe('exact-name')

    machine.branchPrefix = undefined
    await service.setProjectPaths({ projectId: project.id, branchPrefix: '' })
    expect((await ready(service, { projectId: project.id, name: 'Plain' })).branch).toBe('plain')
  })

  it('refuses a prefix no branch could start with', async () => {
    const { service, project } = await setup()
    const refused = await service.setProjectPaths({ projectId: project.id, branchPrefix: 'a b/' }).catch((e) => e)
    expect(refused).toBeInstanceOf(GitServiceError)
  })
})
