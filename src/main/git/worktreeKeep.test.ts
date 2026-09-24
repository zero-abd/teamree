import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { GitService } from './gitService'
import { keptName } from './worktreeKeep'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

const TASK = 'Add a sub function to src/math.ts'

async function fannedOut(agents: string[]): Promise<{ repo: TempRepo; service: GitService; runs: Worktree[] }> {
  const repo = await createTempRepo()
  repos.push(repo)
  const service = new GitService({ worktreesRoot: repo.worktreesRoot })
  services.push(service)
  const project = await service.addProject({ path: repo.repoPath })
  const runs: Worktree[] = []
  for (const agent of agents) {
    const pending = await service.createWorktree({ projectId: project.id, name: `Add sub ${agent}`, task: TASK })
    runs.push(await service.whenSettled(pending.id))
  }
  // Not a run of this task: keeping a run must leave it alone.
  const other = await service.createWorktree({ projectId: project.id, name: 'Unrelated', task: 'Something else' })
  runs.push(await service.whenSettled(other.id))
  return { repo, service, runs }
}

describe('keptName', () => {
  it('drops the agent the run was named after when every sibling shares the rest', () => {
    const run = (name: string): Pick<Worktree, 'name'> => ({ name })
    expect(keptName(run('Add sub claude'), [run('Add sub codex')])).toBe('Add sub')
    expect(keptName(run('Add sub claude 2'), [run('Add sub claude'), run('Add sub codex')])).toBe('Add sub')
    expect(keptName(run('Add sub'), [run('Fix login')])).toBeNull()
  })
})

describe('keeping one run', () => {
  it('removes the other two runs, keeps their branches, and names the kept run after the task', async () => {
    const { repo, service, runs } = await fannedOut(['claude', 'codex', 'claude 2'])
    const [kept, codex, second, unrelated] = runs as [Worktree, Worktree, Worktree, Worktree]

    const result = await service.keepWorktree({ worktreeId: kept.id })

    expect(result.removed.sort()).toEqual([codex.id, second.id].sort())
    expect(result.worktree).toMatchObject({ id: kept.id, name: 'Add sub', branch: kept.branch })
    expect((await service.listWorktrees()).map((worktree) => worktree.id).sort()).toEqual(
      [kept.id, unrelated.id].sort()
    )
    const branches = await repo.git(['branch', '--format=%(refname:short)'])
    expect(branches.split('\n')).toEqual(expect.arrayContaining([codex.branch, second.branch]))
  })

  it('removes three other runs', async () => {
    const { service, runs } = await fannedOut(['claude', 'codex', 'claude 2', 'codex 2'])
    const [kept] = runs as [Worktree]

    const result = await service.keepWorktree({ worktreeId: runs[3]!.id })

    expect(result.removed).toHaveLength(3)
    expect(result.removed).toContain(kept.id)
    expect(result.worktree.name).toBe('Add sub')
  })

  it('removes nothing without force while any other run holds uncommitted work', async () => {
    const { repo, service, runs } = await fannedOut(['claude', 'codex', 'claude 2'])
    const [kept, codex] = runs as [Worktree, Worktree]
    await repo.write('notes.md', 'unsaved\n', codex.path)

    const refused = await service.keepWorktree({ worktreeId: kept.id }).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(GitServiceError)
    expect((refused as GitServiceError).code).toBe(ErrorCode.Conflict)
    expect(await service.listWorktrees()).toHaveLength(4)

    const forced = await service.keepWorktree({ worktreeId: kept.id, force: true })
    expect(forced.removed).toHaveLength(2)
  })
})
