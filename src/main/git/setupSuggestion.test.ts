// The setup command read off a project's lockfile: offered on the project, checked per worktree,
// and never run until someone presses Run.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService, type GitServiceOptions } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function npmRepo(): Promise<TempRepo> {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.write('package.json', '{}\n')
  await repo.write('package-lock.json', '{}\n')
  await repo.commit('npm project')
  return repo
}

function newService(repo: TempRepo, ran: string[]): GitService {
  const startSetup: GitServiceOptions['startSetup'] = ({ command }) => (ran.push(command), 't_setup')
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, startSetup })
  services.push(service)
  return service
}

describe('a setup command suggested from the lockfile', () => {
  it('rides on the project until one is set', async () => {
    const repo = await npmRepo()
    const service = newService(repo, [])
    const project = await service.addProject({ path: repo.repoPath })
    expect(project.suggestedSetup).toBe('npm ci')

    const set = await service.setProjectPaths({ projectId: project.id, setupCommand: 'npm ci' })
    expect(set.suggestedSetup).toBeUndefined()
    expect(service.listProjects()[0]?.suggestedSetup).toBeUndefined()
  })

  it('is not offered when the repository file names a command', async () => {
    const repo = await npmRepo()
    await repo.write('.teamree/project.json', '{"setupCommand": "make deps"}')
    await repo.commit('share setup')
    const service = newService(repo, [])
    const project = await service.addProject({ path: repo.repoPath })
    expect(project.suggestedSetup).toBeUndefined()
  })

  it('never runs on its own when a worktree is made', async () => {
    const repo = await npmRepo()
    const ran: string[] = []
    const service = newService(repo, ran)
    const project = await service.addProject({ path: repo.repoPath })

    const pending = await service.createWorktree({ projectId: project.id, name: 'fresh' })
    const worktree = await service.whenSettled(pending.id)

    expect(worktree.state).toBe('ready')
    expect(ran).toEqual([])
    expect(worktree.setupTerminalId).toBeUndefined()
    expect(worktree.setupAsk).toBeUndefined()
  })

  it('says what a worktree lacks, and stops once it is there', async () => {
    const repo = await npmRepo()
    const service = newService(repo, [])
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await service.whenSettled((await service.createWorktree({ projectId: project.id, name: 'x' })).id)

    expect(await service.checkSetup({ worktreeId: worktree.id })).toEqual({
      command: 'npm ci',
      missing: 'node_modules'
    })
    await mkdir(path.join(worktree.path, 'node_modules'))
    expect(await service.checkSetup({ worktreeId: worktree.id })).toEqual({ command: 'npm ci' })
  })

  it('runs exactly the command Run was pressed on, in that worktree', async () => {
    const repo = await npmRepo()
    const ran: string[] = []
    const service = newService(repo, ran)
    const project = await service.addProject({ path: repo.repoPath })
    const worktree = await service.whenSettled((await service.createWorktree({ projectId: project.id, name: 'x' })).id)

    const after = await service.runSetup({ worktreeId: worktree.id, command: '  npm ci  ' })
    expect(ran).toEqual(['npm ci'])
    expect(after.setupTerminalId).toBe('t_setup')
    // Running here approves nothing for the project.
    expect(service.listProjects()[0]?.setupCommand).toBeUndefined()

    const blank = await service.runSetup({ worktreeId: worktree.id, command: '  ' }).catch((error: unknown) => error)
    expect(blank).toBeInstanceOf(GitServiceError)
    expect((blank as GitServiceError).code).toBe(ErrorCode.InvalidParams)
    expect(ran).toEqual(['npm ci'])
  })
})
