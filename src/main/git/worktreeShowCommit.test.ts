import { afterEach, describe, expect, it } from 'vitest'
import { parsePatch } from '../../shared/patch'
import { createTempRepo, type TempRepo } from './testRepository'
import { readCommit } from './worktreeShowCommit'

describe('reading one commit from a real repository', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  const show = (repo: TempRepo, sha: string, maxBytes?: number): ReturnType<typeof readCommit> =>
    readCommit(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      sha,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      now: () => 123
    })

  it('answers the commit’s fields and its patch against its parent', async () => {
    const repo = await repository()
    await repo.write('src/math.ts', 'export const add = (a: number, b: number) => a + b\n')
    await repo.commit('Add add')
    await repo.write(
      'src/math.ts',
      'export const add = (a: number, b: number) => a + b\nexport const sub = (a: number, b: number) => a - b\n'
    )
    await repo.commit('Add sub')
    const sha = await repo.git(['rev-parse', 'HEAD'])

    const commit = await show(repo, sha.slice(0, 7))

    expect(commit).toMatchObject({
      worktreeId: 'wt',
      sha,
      shortSha: sha.slice(0, 7),
      author: 'Teamree Test',
      subject: 'Add sub',
      truncated: false,
      readAt: 123
    })
    const files = parsePatch(commit.patch)
    expect(files.map((file) => file.path)).toEqual(['src/math.ts'])
    const lines = files[0]?.hunks.flatMap((hunk) => hunk.lines) ?? []
    expect(lines.filter((line) => line.kind === 'added').map((line) => line.text)).toEqual([
      'export const sub = (a: number, b: number) => a - b'
    ])
    expect(lines.some((line) => line.kind === 'removed')).toBe(false)
  })

  it('shows a root commit as every file added', async () => {
    const repo = await repository()
    const root = await repo.git(['rev-list', '--max-parents=0', 'HEAD'])

    const commit = await show(repo, root)

    expect(commit.subject).toBe('initial commit')
    expect(parsePatch(commit.patch).map((file) => [file.path, file.status])).toEqual([['README.md', 'added']])
  })

  // A combined diff is a format the viewer does not read; the first parent is what the branch gained.
  it('shows a merge against its first parent', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'side'])
    await repo.write('side.txt', 'from the side\n')
    await repo.commit('side work')
    await repo.git(['checkout', '-q', 'main'])
    await repo.write('main.txt', 'from main\n')
    await repo.commit('main work')
    await repo.git(['merge', '--no-ff', '--no-edit', 'side'])
    const merge = await repo.git(['rev-parse', 'HEAD'])

    const commit = await show(repo, merge)

    expect(parsePatch(commit.patch).map((file) => file.path)).toEqual(['side.txt'])
  })

  it('cuts a patch past the ceiling and says so', async () => {
    const repo = await repository()
    await repo.write('big.txt', `${'a line of text\n'.repeat(2000)}`)
    await repo.commit('Add a big file')
    const sha = await repo.git(['rev-parse', 'HEAD'])

    const commit = await show(repo, sha, 4096)

    expect(commit.truncated).toBe(true)
    expect(Buffer.byteLength(commit.patch, 'utf8')).toBeLessThanOrEqual(4096)
    expect(commit.subject).toBe('Add a big file')
  })

  it('refuses a commit the repository does not have', async () => {
    const repo = await repository()
    await expect(show(repo, 'f'.repeat(40))).rejects.toThrow()
  })

  it('refuses anything but a hex object name, so no ref or option reaches git', async () => {
    const repo = await repository()
    await expect(show(repo, 'HEAD')).rejects.toThrow()
    await expect(show(repo, '--output=/tmp/x')).rejects.toThrow()
  })
})
