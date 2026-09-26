import { afterEach, describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/entities'
import { createTempRepo, type TempRepo } from '../../git/testRepository'
import { readTaskGitDetails, TaskDetails, TASK_DETAILS_REFRESH_MS, type TaskGitDetails } from './presenceDetails'

const repos: TempRepo[] = []
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.cleanup()
})

describe('readTaskGitDetails', () => {
  it('lists committed and uncommitted paths against the base, and counts commits ahead', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.git(['checkout', '-b', 'feature'])
    await repo.write('src/committed.ts', 'export const secret = "hunter2"\n')
    await repo.commit('one')
    await repo.write('src/second.ts', 'export {}\n')
    await repo.commit('two')
    await repo.write('README.md', '# changed\n')
    await repo.write('notes/new.md', 'draft\n')

    const details = await readTaskGitDetails(repo.runner, { worktreePath: repo.repoPath, baseRef: 'main' })
    expect(details.ahead).toBe(2)
    expect(details.clean).toBe(false)
    expect([...details.paths].sort()).toEqual(['README.md', 'notes/new.md', 'src/committed.ts', 'src/second.ts'])
    expect(JSON.stringify(details)).not.toContain('hunter2')
  })

  it('folds a crowd of new files into their folder', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    for (let index = 0; index < 30; index += 1) await repo.write(`generated/file-${index}.ts`, 'export {}\n')
    const details = await readTaskGitDetails(repo.runner, { worktreePath: repo.repoPath, baseRef: 'main' })
    expect(details.paths).toEqual(['generated/'])
  })

  it('says clean and ahead for a branch with only commits, and leaves out prepared paths', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.git(['checkout', '-b', 'feature'])
    await repo.write('src/a.ts', 'export {}\n')
    await repo.commit('one')
    await repo.write('.env', 'TOKEN=1\n')

    const details = await readTaskGitDetails(repo.runner, {
      worktreePath: repo.repoPath,
      baseRef: 'main',
      prepared: { copiedPaths: ['.env'] }
    })
    expect(details).toEqual({ paths: ['src/a.ts'], ahead: 1, clean: true })
  })

  it('answers no commits for a base ref git cannot see', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const details = await readTaskGitDetails(repo.runner, { worktreePath: repo.repoPath, baseRef: 'origin/nowhere' })
    expect(details).toEqual({ paths: [], ahead: 0, clean: true })
  })
})

describe('TaskDetails', () => {
  const worktree = (id: string): Worktree => ({
    id,
    projectId: 'p1',
    name: id,
    branch: id,
    path: `/tmp/${id}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0
  })

  function rig(answers: Map<string, TaskGitDetails>) {
    const timers: { run: () => void; delayMs: number }[] = []
    let changes = 0
    let reads = 0
    const details = new TaskDetails({
      read: (target) => {
        reads += 1
        return Promise.resolve(answers.get(target.id))
      },
      setTimer: (run, delayMs) => {
        timers.push({ run, delayMs })
        return () => undefined
      },
      onChange: () => {
        changes += 1
      }
    })
    const fire = async (): Promise<void> => {
      timers.shift()?.run()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { details, timers, fire, changes: () => changes, reads: () => reads }
  }

  it('reads once per burst and reports a change only when something moved', async () => {
    const answers = new Map([['w1', { paths: ['a.ts'], ahead: 1, clean: true }]])
    const { details, timers, fire, changes, reads } = rig(answers)
    details.request(() => [worktree('w1')])
    details.request(() => [worktree('w1')])
    expect(timers).toHaveLength(1)
    expect(timers[0]?.delayMs).toBe(TASK_DETAILS_REFRESH_MS)
    await fire()
    expect(details.get('w1')).toEqual({ paths: ['a.ts'], ahead: 1, clean: true })
    expect(changes()).toBe(1)

    details.request(() => [worktree('w1')])
    await fire()
    expect(reads()).toBe(2)
    expect(changes()).toBe(1)
  })

  it('forgets a worktree that is gone', async () => {
    const answers = new Map([['w1', { paths: ['a.ts'], ahead: 1, clean: true }]])
    const { details, fire } = rig(answers)
    details.request(() => [worktree('w1')])
    await fire()
    details.request(() => [])
    await fire()
    expect(details.get('w1')).toBeUndefined()
  })
})
