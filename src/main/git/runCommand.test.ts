// Run Dev and Run Tests as the runtime answers them: which command, and the one question a
// repository's command gets before it first runs on this Mac.

import { afterEach, describe, expect, it } from 'vitest'
import type { RunKind, Terminal } from '../../shared/entities'
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

type Started = { worktreeId: string; kind: RunKind; command: string; restart: boolean }

async function scriptsRepo(projectFile?: string): Promise<TempRepo> {
  const repo = await createTempRepo()
  repos.push(repo)
  await repo.write('package.json', JSON.stringify({ scripts: { dev: 'node dev.js', test: 'node test.js' } }))
  if (projectFile !== undefined) await repo.write('.teamree/project.json', projectFile)
  await repo.commit('scripts')
  return repo
}

function newService(repo: TempRepo, started: Started[]): GitService {
  const runPanes: GitServiceOptions['runPanes'] = {
    start: async (input) => {
      started.push(input)
      return { id: 't_run', worktreeId: input.worktreeId, run: input.kind, running: true } as Terminal
    },
    stop: async () => null
  }
  const service = new GitService({ worktreesRoot: repo.worktreesRoot, runPanes })
  services.push(service)
  return service
}

async function readyWorktree(service: GitService, repo: TempRepo): Promise<{ projectId: string; worktreeId: string }> {
  const project = await service.addProject({ path: repo.repoPath })
  const worktree = await service.whenSettled((await service.createWorktree({ projectId: project.id, name: 'x' })).id)
  return { projectId: project.id, worktreeId: worktree.id }
}

describe('Run Dev and Run Tests', () => {
  it('detects the scripts on the project and runs them without asking', async () => {
    const repo = await scriptsRepo()
    const started: Started[] = []
    const service = newService(repo, started)
    const { projectId, worktreeId } = await readyWorktree(service, repo)
    expect(service.listProjects().find((project) => project.id === projectId)?.detectedRun).toEqual({
      dev: 'npm run dev',
      test: 'npm test'
    })

    await service.runCommand({ worktreeId, kind: 'test' })
    await service.runCommand({ worktreeId, kind: 'dev', restart: true })
    expect(started).toEqual([
      { worktreeId, kind: 'test', command: 'npm test', restart: false },
      { worktreeId, kind: 'dev', command: 'npm run dev', restart: true }
    ])
  })

  it('runs this Mac’s command over the detected one, and clears it with an empty string', async () => {
    const repo = await scriptsRepo()
    const started: Started[] = []
    const service = newService(repo, started)
    const { projectId, worktreeId } = await readyWorktree(service, repo)

    const set = await service.setProjectPaths({ projectId, runCommands: { test: '  npx vitest  ' } })
    expect(set.runCommands).toEqual({ test: 'npx vitest' })
    await service.runCommand({ worktreeId, kind: 'test' })
    const cleared = await service.setProjectPaths({ projectId, runCommands: { test: '' } })
    expect(cleared.runCommands).toBeUndefined()
    await service.runCommand({ worktreeId, kind: 'test' })
    expect(started.map((entry) => entry.command)).toEqual(['npx vitest', 'npm test'])
  })

  it('refuses a repository command this Mac has not approved, then runs it once approved', async () => {
    const repo = await scriptsRepo('{"runCommands": {"test": "make check"}}')
    const started: Started[] = []
    const service = newService(repo, started)
    const { projectId, worktreeId } = await readyWorktree(service, repo)

    const refusal = await service.runCommand({ worktreeId, kind: 'test' }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(GitServiceError)
    expect((refusal as GitServiceError).code).toBe(ErrorCode.Conflict)
    expect(started).toEqual([])

    await service.runCommand({ worktreeId, kind: 'test', approve: true })
    expect(service.listProjects().find((project) => project.id === projectId)?.approvedRunCommands).toEqual({
      test: 'make check'
    })
    // Approved once: the next press runs without asking.
    await service.runCommand({ worktreeId, kind: 'test' })
    expect(started.map((entry) => entry.command)).toEqual(['make check', 'make check'])
  })

  it('asks again when the repository changes the command it approved', async () => {
    const repo = await scriptsRepo('{"runCommands": {"dev": "make serve"}}')
    const service = newService(repo, [])
    const { worktreeId } = await readyWorktree(service, repo)
    await service.runCommand({ worktreeId, kind: 'dev', approve: true })

    await repo.write('.teamree/project.json', '{"runCommands": {"dev": "make serve PORT=1"}}')
    await service.refreshProjectFiles()
    await expect(service.runCommand({ worktreeId, kind: 'dev' })).rejects.toMatchObject({ code: ErrorCode.Conflict })
  })

  it('refuses a kind the project has no command for', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const service = newService(repo, [])
    const { worktreeId } = await readyWorktree(service, repo)
    await expect(service.runCommand({ worktreeId, kind: 'dev' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams
    })
  })
})

describe('saved commands', () => {
  const lint = { id: 'c1', label: ' Lint ', text: '  npm run lint ', kind: 'shell', where: 'new' } as const

  it('keeps this Mac’s list in order, trimmed, and clears it with an empty one', async () => {
    const repo = await scriptsRepo()
    const service = newService(repo, [])
    const { projectId } = await readyWorktree(service, repo)
    const review = { id: 'c2', label: 'Review', text: 'Review the diff', kind: 'agent', where: 'current' } as const

    const set = await service.setProjectPaths({ projectId, savedCommands: [review, lint] })
    expect(set.savedCommands).toEqual([review, { ...lint, label: 'Lint', text: 'npm run lint' }])
    const cleared = await service.setProjectPaths({ projectId, savedCommands: [] })
    expect(cleared.savedCommands).toBeUndefined()
  })

  it('reads the repository’s, and approves only a text it carries', async () => {
    const shared = { id: 'r1', label: 'Migrate', text: 'npm run db:migrate', kind: 'shell', where: 'new' }
    const repo = await scriptsRepo(JSON.stringify({ savedCommands: [shared] }))
    const service = newService(repo, [])
    const { projectId } = await readyWorktree(service, repo)
    expect(service.listProjects().find((project) => project.id === projectId)?.repository?.savedCommands).toEqual([
      shared
    ])

    await expect(service.setProjectPaths({ projectId, approveCommand: 'rm -rf /' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams
    })
    const approved = await service.setProjectPaths({ projectId, approveCommand: shared.text })
    expect(approved.approvedSavedCommands).toEqual([shared.text])
    const again = await service.setProjectPaths({ projectId, approveCommand: shared.text })
    expect(again.approvedSavedCommands).toEqual([shared.text])
  })
})
