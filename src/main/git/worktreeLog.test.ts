import { afterEach, describe, expect, it } from 'vitest'
import { createTempRepo, type TempRepo } from './testRepository'
import { parseLogRecords, readWorktreeLog } from './worktreeLog'

/** Builds the NUL-separated stream git's format produces. */
const records = (...commits: string[][]): string => commits.map((fields) => `${fields.join('\0')}\0`).join('')

describe('parseLogRecords', () => {
  it('reads a commit into its fields', () => {
    const parsed = parseLogRecords(records(['abc1234567890', 'Ada', '2026-01-02T03:04:05+01:00', 'do the thing']))

    expect(parsed).toEqual([
      {
        sha: 'abc1234567890',
        shortSha: 'abc1234',
        author: 'Ada',
        committedAt: '2026-01-02T03:04:05+01:00',
        subject: 'do the thing'
      }
    ])
  })

  // The reason the fields are NUL-separated rather than line-separated: a
  // subject can contain anything, newlines included, and a line-based reader
  // turns one commit into two.
  it('keeps a subject that contains a newline as one commit', () => {
    const parsed = parseLogRecords(records(['abc1234', 'Ada', '2026-01-02T03:04:05Z', 'first line\nsecond line']))

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.subject).toBe('first line\nsecond line')
  })

  it('keeps the order it was given, which is newest first', () => {
    const parsed = parseLogRecords(
      records(['aaa1111', 'Ada', '2026-01-02T00:00:00Z', 'newer'], ['bbb2222', 'Ada', '2026-01-01T00:00:00Z', 'older'])
    )

    expect(parsed.map((commit) => commit.subject)).toEqual(['newer', 'older'])
  })

  it('drops a half-written record rather than half-reporting it', () => {
    expect(parseLogRecords('abc1234\0Ada\0')).toEqual([])
  })

  it('is unbothered by empty output', () => {
    expect(parseLogRecords('')).toEqual([])
  })
})

describe('reading a worktree’s log from a real repository', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (): Promise<TempRepo> => {
    const repo = await createTempRepo()
    repos.push(repo)
    return repo
  }

  const read = async (repo: TempRepo, limit?: number): ReturnType<typeof readWorktreeLog> =>
    readWorktreeLog(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      baseRef: 'main',
      branch: 'feature',
      ...(limit === undefined ? {} : { limit }),
      now: () => 123
    })

  it('reports what the branch did, newest first', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.write('one.txt', 'a\n')
    await repo.commit('the first thing')
    await repo.write('two.txt', 'b\n')
    await repo.commit('the second thing')
    await repo.git(['checkout', '-q', 'main'])

    const log = await read(repo)

    expect(log.commits.map((commit) => commit.subject)).toEqual(['the second thing', 'the first thing'])
    expect(log.commits[0]?.shortSha).toHaveLength(7)
    expect(log.commits[0]?.author).toBe('Teamree Test')
    expect(log.truncated).toBe(false)
    expect(log.readAt).toBe(123)
  })

  // Everything before the fork belongs to the whole repository, and listing it
  // would bury the three commits the worktree actually made.
  it('says nothing about commits the base already had', async () => {
    const repo = await repository()
    await repo.write('shared.txt', 'a\n')
    await repo.commit('a commit on main')
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.write('mine.txt', 'b\n')
    await repo.commit('only mine')
    await repo.git(['checkout', '-q', 'main'])

    const log = await read(repo)

    expect(log.commits.map((commit) => commit.subject)).toEqual(['only mine'])
  })

  it('is empty for a branch that has done nothing yet', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.git(['checkout', '-q', 'main'])

    const log = await read(repo)

    expect(log.commits).toEqual([])
    expect(log.truncated).toBe(false)
  })

  it('caps the list and says that it capped it', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    for (let index = 0; index < 5; index += 1) {
      await repo.write(`file-${index}.txt`, `${index}\n`)
      await repo.commit(`commit ${index}`)
    }
    await repo.git(['checkout', '-q', 'main'])

    const log = await read(repo, 2)

    expect(log.commits).toHaveLength(2)
    expect(log.truncated).toBe(true)
    // The newest two, not the oldest two.
    expect(log.commits.map((commit) => commit.subject)).toEqual(['commit 4', 'commit 3'])
  })

  it('survives a subject with a newline in it, end to end', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])
    await repo.write('one.txt', 'a\n')
    await repo.git(['add', '--all'])
    await repo.git(['commit', '--no-verify', '-m', 'subject line', '-m', 'and a body paragraph'])
    await repo.git(['checkout', '-q', 'main'])

    const log = await read(repo)

    // The body is not the subject, and neither is half of it.
    expect(log.commits).toHaveLength(1)
    expect(log.commits[0]?.subject).toBe('subject line')
  })

  it('says nothing rather than failing when the base ref does not resolve', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature', 'main'])

    const log = await readWorktreeLog(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      baseRef: 'origin/never-fetched',
      branch: 'feature'
    })

    expect(log.commits).toEqual([])
  })
})
