import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './gitService'
import { createTempRepo, type TempRepo } from './testRepository'
import { parsePorcelainV2, readWorktreeStatus } from './worktreeStatus'

/** Builds a NUL-separated status stream the way git writes one. */
const records = (...entries: string[]): string => entries.map((entry) => `${entry}\0`).join('')

const repos: TempRepo[] = []
const services: GitService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

describe('parsePorcelainV2', () => {
  it('separates staged, unstaged, untracked and conflicted entries', () => {
    const parsed = parsePorcelainV2(
      records(
        '# branch.oid 1111111111111111111111111111111111111111',
        '# branch.head feature',
        '# branch.upstream origin/feature',
        '# branch.ab +3 -2',
        '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
        '1 .M N... 100644 100644 100644 aaa bbb unstaged.txt',
        '1 MM N... 100644 100644 100644 aaa bbb both.txt',
        '2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt',
        'original.txt',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt',
        '? untracked one.txt',
        '! ignored.txt'
      )
    )

    expect(parsed).toEqual({
      branch: 'feature',
      detached: false,
      upstream: 'origin/feature',
      ahead: 3,
      behind: 2,
      staged: 3, // staged.txt, both.txt, renamed.txt
      unstaged: 2, // unstaged.txt, both.txt
      untracked: 1,
      conflicted: 1,
      // Counted apart: an ignored file is not a change, but a removal would delete it.
      ignored: 1,
      ignoredPaths: ['ignored.txt']
    })
  })

  it('does not count what the project carries into every worktree', () => {
    const stream = records('# branch.head main', '? node_modules', '? .env', '? notes.md')

    const parsed = parsePorcelainV2(stream, { linkedPaths: ['node_modules'], copiedPaths: ['.env'] })

    expect(parsePorcelainV2(stream).untracked).toBe(3)
    expect(parsed.untracked).toBe(1)
  })

  it('reports a detached head with no branch and no divergence', () => {
    const parsed = parsePorcelainV2(records('# branch.oid abc', '# branch.head (detached)'))
    expect(parsed.detached).toBe(true)
    expect(parsed.branch).toBe('')
    expect(parsed.ahead).toBe(0)
    expect(parsed.behind).toBe(0)
  })
})

describe('worktree.status', () => {
  it('counts every kind of change in a real worktree and measures divergence from the base ref', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const service = new GitService({ worktreesRoot: repo.worktreesRoot })
    services.push(service)

    await repo.write('a.txt', 'a\n')
    await repo.write('b.txt', 'b\n')
    await repo.write('c.txt', 'base\n')
    await repo.commit('add tracked files')

    const project = await service.addProject({ path: repo.repoPath })
    const pending = await service.createWorktree({ projectId: project.id, name: 'status check' })
    const worktree = await service.whenSettled(pending.id)
    expect(worktree.state).toBe('ready')

    // Diverge in both directions, then collide on the same file.
    await repo.write('c.txt', 'theirs\n', worktree.path)
    await repo.commit('branch edits c', worktree.path)
    await repo.write('c.txt', 'ours\n')
    await repo.commit('main edits c')
    const merge = await repo.runner.tryRun({ args: ['merge', 'main'], cwd: worktree.path })
    expect(merge.exitCode).not.toBe(0) // the conflict is the point of the test

    await repo.write('a.txt', 'staged change\n', worktree.path)
    await repo.git(['add', 'a.txt'], worktree.path)
    await repo.write('b.txt', 'unstaged change\n', worktree.path)
    await repo.write('new.txt', 'brand new\n', worktree.path)

    const status = await service.worktreeStatus({ worktreeId: worktree.id })

    expect(status).toMatchObject({
      worktreeId: worktree.id,
      branch: 'status-check',
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicted: 1,
      ahead: 1,
      behind: 1
    })
    expect(status.readAt).toBeGreaterThan(0)
  })

  it('uses the upstream for ahead/behind once the branch is pushed', async () => {
    const repo = await createTempRepo({ withRemote: true })
    repos.push(repo)
    const service = new GitService({ worktreesRoot: repo.worktreesRoot })
    services.push(service)

    const project = await service.addProject({ path: repo.repoPath })
    const pending = await service.createWorktree({ projectId: project.id, name: 'pushed work' })
    const worktree = await service.whenSettled(pending.id)

    await repo.git(['push', '-u', 'origin', 'HEAD'], worktree.path)
    await repo.write('later.txt', 'later\n', worktree.path)
    await repo.commit('work after pushing', worktree.path)

    const status = await service.worktreeStatus({ worktreeId: worktree.id })

    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(0)
    expect(status.staged).toBe(0)
    expect(status.unstaged).toBe(0)
    expect(status.untracked).toBe(0)
  })

  // `ahead` belongs to the upstream and `behind` to the base ref; they were the same
  // number while the upstream was the base, and a push fixing one silently took the other.
  it('reads what is left to push from the upstream and what is left to merge from the base', async () => {
    const repo = await createTempRepo({ withRemote: true })
    repos.push(repo)
    const service = new GitService({ worktreesRoot: repo.worktreesRoot })
    services.push(service)

    const project = await service.addProject({ path: repo.repoPath })
    const pending = await service.createWorktree({ projectId: project.id, name: 'push me' })
    const worktree = await service.whenSettled(pending.id)
    expect(worktree.state, worktree.error).toBe('ready')

    await repo.write('work.ts', 'export const a = 1\n', worktree.path)
    await repo.commit('work in the worktree', worktree.path)

    // The base moves on twice: the `2 behind` the sidebar draws, which must survive the push.
    await repo.write('base-one.ts', '1\n')
    await repo.commit('base one')
    await repo.write('base-two.ts', '2\n')
    await repo.commit('base two')
    await repo.git(['push', 'origin', 'main'])

    const before = await service.worktreeStatus({ worktreeId: worktree.id })
    expect(before.ahead).toBe(1)
    expect(before.behind).toBe(2)

    const pushed = await service.worktreePush({ worktreeId: worktree.id })
    expect(pushed.upstream).toBe('origin/push-me')

    // The branch tracks itself on the remote now, and the base is still two ahead.
    expect(await repo.git(['rev-parse', '--abbrev-ref', '@{upstream}'], worktree.path)).toBe('origin/push-me')
    const after = await service.worktreeStatus({ worktreeId: worktree.id })
    expect(after.ahead).toBe(0)
    expect(after.behind).toBe(2)
  })
})

describe('divergence against a base ref', () => {
  // `rev-list --left-right --count HEAD...HEAD` exits 0 and prints "0 0", so a
  // branch holding a week of commits reads as in sync with itself.
  it('refuses a base of HEAD rather than counting the branch against itself', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.git(['checkout', '-q', '-b', 'task'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('a day of work')

    const status = await readWorktreeStatus(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      fallbackBranch: 'task',
      baseRef: 'HEAD'
    })

    const counted = await repo.runner.tryRun({
      args: ['rev-list', '--left-right', '--count', 'HEAD...HEAD'],
      cwd: repo.repoPath
    })
    // git answers the self-comparison happily; this is what it would have said.
    expect(counted.stdout.trim()).toBe('0\t0')
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('still counts against a base that is a real commit', async () => {
    const repo = await createTempRepo()
    repos.push(repo)
    const base = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['checkout', '-q', '-b', 'task'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('a day of work')

    const status = await readWorktreeStatus(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      fallbackBranch: 'task',
      baseRef: base
    })

    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(0)
  })
})
