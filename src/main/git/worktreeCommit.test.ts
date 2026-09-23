import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { createTempRepo, type TempRepo } from './testRepository'
import { commitWorktree } from './worktreeCommit'

describe('committing in a worktree', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  const commit = async (
    repo: TempRepo,
    options: { message?: string; paths?: string[] } = {}
  ): ReturnType<typeof commitWorktree> =>
    commitWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      message: options.message ?? 'a message',
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      now: () => 4242
    })

  it('stages the paths it is given and commits exactly those', async () => {
    const repo = await repository()
    await repo.write('wanted.ts', 'export const a = 1\n')
    await repo.write('not-wanted.log', 'noise\n')

    const result = await commit(repo, { message: 'add the thing', paths: ['wanted.ts'] })

    expect(result.paths).toEqual(['wanted.ts'])
    expect(result.message).toBe('add the thing')
    expect(result.shortSha).toBe(result.sha.slice(0, 7))
    expect(result.committedAt).toBe(4242)
    expect(await repo.git(['show', '--name-only', '--format=', 'HEAD'])).toBe('wanted.ts')
    // The file nobody named is still sitting there untracked.
    expect(await repo.git(['status', '--porcelain'])).toContain('not-wanted.log')
  })

  it('commits what was already staged when no paths are named', async () => {
    const repo = await repository()
    await repo.write('staged.ts', 'export const a = 1\n')
    await repo.write('loose.ts', 'export const b = 2\n')
    await repo.git(['add', 'staged.ts'])

    const result = await commit(repo)

    expect(result.paths).toEqual(['staged.ts'])
    expect(await repo.git(['status', '--porcelain'])).toContain('loose.ts')
  })

  it('commits a partly staged file as the index holds it, leaving the rest unstaged', async () => {
    const repo = await repository()
    await repo.write('two.txt', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n')
    await repo.commit('add two')
    await repo.write('two.txt', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n')
    const top = (await repo.git(['diff', '-U0', '--', 'two.txt'])).split('\n@@ -10')[0]!
    await repo.runner.run({ args: ['apply', '--cached', '--unidiff-zero', '-'], cwd: repo.repoPath, stdin: `${top}\n` })

    const result = await commit(repo)

    expect(result.paths).toEqual(['two.txt'])
    expect(await repo.git(['show', 'HEAD:two.txt'])).toBe('A\nb\nc\nd\ne\nf\ng\nh\ni\nj')
    expect(await repo.git(['diff', '--no-color', '-U0'])).toContain('+J')
  })

  // The report has to describe the commit, not the request: a path staged
  // earlier rides along, and pretending otherwise is a lie about the history.
  it('reports everything the commit captured, not only what was asked for', async () => {
    const repo = await repository()
    await repo.write('earlier.ts', 'export const a = 1\n')
    await repo.git(['add', 'earlier.ts'])
    await repo.write('now.ts', 'export const b = 2\n')

    const result = await commit(repo, { paths: ['now.ts'] })

    expect(result.paths).toEqual(['earlier.ts', 'now.ts'])
  })

  it('refuses when nothing is staged and nothing was named', async () => {
    const repo = await repository()
    await repo.write('untouched-by-git.ts', 'export const a = 1\n')

    await expect(commit(repo)).rejects.toThrow(/nothing is staged/i)
  })

  it('refuses when the paths named have nothing to commit', async () => {
    const repo = await repository()
    await repo.write('tracked.ts', 'export const a = 1\n')
    await repo.commit('add tracked')

    await expect(commit(repo, { paths: ['tracked.ts'] })).rejects.toThrow(/nothing staged/i)
  })

  it('refuses an empty message rather than writing one', async () => {
    const repo = await repository()
    await repo.write('a.ts', 'export const a = 1\n')

    await expect(commit(repo, { message: '   ', paths: ['a.ts'] })).rejects.toBeInstanceOf(GitServiceError)
  })

  // Committing a conflicted tree writes the conflict markers into the history
  // as if they were code, and it is the kind of mistake nobody notices for days.
  it('refuses a worktree with unresolved conflicts, and names them', async () => {
    const repo = await repository()
    await repo.write('shared.txt', 'one\ntwo\nthree\n')
    await repo.commit('add shared')
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('shared.txt', 'one\nFEATURE\nthree\n')
    await repo.commit('feature edit')
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('shared.txt', 'one\nMAIN\nthree\n')
    await repo.commit('main edit')
    // Leaves the worktree mid-merge with a conflicted file, which is the state
    // under test.
    const merge = await repo.runner.tryRun({ args: ['merge', 'feature'], cwd: repo.repoPath })
    expect(merge.exitCode).not.toBe(0)

    await expect(commit(repo, { message: 'resolve it' })).rejects.toThrow(/shared\.txt/)
  })

  it('keeps a path that looks like a flag a path', async () => {
    const repo = await repository()
    await repo.write('--not-a-flag.txt', 'tricky\n')

    const result = await commit(repo, { paths: ['--not-a-flag.txt'] })

    expect(result.paths).toEqual(['--not-a-flag.txt'])
  })

  it('leaves the history alone when it refuses', async () => {
    const repo = await repository()
    const before = await repo.git(['rev-parse', 'HEAD'])

    await expect(commit(repo)).rejects.toThrow()

    expect(await repo.git(['rev-parse', 'HEAD'])).toBe(before)
  })
})
