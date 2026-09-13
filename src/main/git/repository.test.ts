import { afterEach, describe, expect, it } from 'vitest'
import { comparesAgainstItself, detectBaseRef } from './repository'
import { createTempRepo, type TempRepo } from './testRepository'

const repos: TempRepo[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

async function newRepo(options: { withRemote?: boolean } = {}): Promise<TempRepo> {
  const repo = await createTempRepo(options)
  repos.push(repo)
  return repo
}

describe('detectBaseRef', () => {
  it('takes the repository’s own answer when it has one', async () => {
    const repo = await newRepo({ withRemote: true })

    expect(await detectBaseRef(repo.runner, repo.repoPath)).toBe('origin/main')
  })

  it('falls back to the checked-out branch where there is no remote', async () => {
    const repo = await newRepo()

    expect(await detectBaseRef(repo.runner, repo.repoPath)).toBe('main')
  })

  /*
   * The literal string "HEAD" is the one answer that cannot be used: every
   * `base..branch` read runs inside the worktree, so HEAD resolves to that
   * worktree's own branch and the comparison silently answers zero. A detached
   * primary checkout — mid-bisect, or parked on a tag — used to produce exactly
   * that.
   */
  it('never hands back HEAD for a detached primary checkout', async () => {
    const repo = await newRepo()
    await repo.write('second.txt', 'more\n')
    await repo.commit('second')
    const sha = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['checkout', '-q', '--detach', sha])

    const baseRef = await detectBaseRef(repo.runner, repo.repoPath)

    expect(baseRef).toBe(sha)
    expect(comparesAgainstItself(baseRef)).toBe(false)
  })
})

describe('comparesAgainstItself', () => {
  it('names the one base that cannot be compared against', () => {
    expect(comparesAgainstItself('HEAD')).toBe(true)
    expect(comparesAgainstItself(' HEAD ')).toBe(true)
    expect(comparesAgainstItself('origin/main')).toBe(false)
    expect(comparesAgainstItself('HEAD~1')).toBe(false)
  })
})
