import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { createTempRepo, type TempRepo } from './testRepository'
import { pushRefusal, pushWorktree } from './worktreePush'

describe('pushRefusal', () => {
  // The message git prints for this suggests forcing to a reader in a hurry,
  // which is precisely the wrong thing to do to somebody else's commits.
  it('explains a rejection without suggesting a force', () => {
    const message = pushRefusal(
      'To /tmp/origin.git\n ! [rejected]   main -> main (non-fast-forward)\nhint: Updates were rejected',
      'origin',
      'main'
    )

    expect(message).toContain('origin has commits that main does not')
    expect(message.toLowerCase()).not.toContain('--force')
    expect(message.toLowerCase()).not.toContain('force')
  })

  it('says when the remote would not let this machine in', () => {
    expect(pushRefusal('fatal: Authentication failed for https://example.invalid/x.git', 'origin', 'work')).toContain(
      'Check that this machine can write to it'
    )
  })

  it('drops git’s "To <url>" line, which is not the reason for anything', () => {
    expect(pushRefusal('To /tmp/origin.git\nfatal: something else went wrong', 'origin', 'work')).toBe(
      'fatal: something else went wrong'
    )
  })

  it('still says something when git said nothing', () => {
    expect(pushRefusal('', 'origin', 'work')).toBe('could not push work to origin')
  })
})

describe('pushing to a real remote', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  const repository = async (options: { withRemote?: boolean } = {}): Promise<TempRepo> => {
    const repo = await createTempRepo(options)
    repos.push(repo)
    return repo
  }

  const push = async (repo: TempRepo, branch: string, remote?: string): ReturnType<typeof pushWorktree> =>
    pushWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch,
      ...(remote === undefined ? {} : { remote }),
      now: () => 777
    })

  it('sends a new branch and sets what it tracks', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')

    const result = await push(repo, 'feature')

    expect(result.setUpstream).toBe(true)
    expect(result.upstream).toBe('origin/feature')
    expect(result.alreadyUpToDate).toBe(false)
    expect(result.pushedAt).toBe(777)
    // It is really on the remote, not merely reported as such.
    expect(await repo.git(['ls-remote', '--heads', 'origin', 'feature'])).toContain('refs/heads/feature')
  })

  // "Everything up-to-date" and "pushed four commits" are different outcomes,
  // and a caller that cannot tell them apart tells somebody the wrong thing.
  it('knows the difference between sending work and having nothing to send', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')

    expect((await push(repo, 'feature')).alreadyUpToDate).toBe(false)
    const second = await push(repo, 'feature')

    expect(second.alreadyUpToDate).toBe(true)
    // The second push did not set tracking again; the first one did that.
    expect(second.setUpstream).toBe(false)
  })

  it('counts the work left behind rather than refusing to push over it', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('committed.ts', 'export const a = 1\n')
    await repo.commit('committed work')
    await repo.write('committed.ts', 'export const a = 2\n')
    await repo.write('untracked.log', 'noise\n')

    const result = await push(repo, 'feature')

    // The edit counts; the stray log does not, because it was never going to
    // be part of a push in the first place.
    expect(result.uncommitted).toBe(1)
    expect(result.alreadyUpToDate).toBe(false)
  })

  it('explains a rejected push instead of leaving git’s wording', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'one\n')
    await repo.commit('first')
    await push(repo, 'feature')

    // Somebody else moves the remote branch on, then this side rewrites its own
    // history — the ordinary way a push gets rejected.
    const other = await repo.git(['rev-parse', 'HEAD'])
    await repo.git(['push', 'origin', `${other}:refs/heads/feature`])
    await repo.write('work.ts', 'two\n')
    await repo.commit('second')
    await repo.git(['reset', '--hard', 'HEAD~1'])
    await repo.write('work.ts', 'divergent\n')
    await repo.commit('divergent')
    await repo.git(['push', 'origin', 'HEAD:refs/heads/feature', '--force'])
    await repo.git(['reset', '--hard', other])
    await repo.write('work.ts', 'behind\n')
    await repo.commit('behind')

    const failure = await push(repo, 'feature').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GitServiceError)
    expect((failure as GitServiceError).message).toContain('has commits that feature does not')
  })

  it('says which remotes exist rather than failing obscurely', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])

    const failure = await push(repo, 'feature', 'upstream').catch((error: unknown) => error)

    expect((failure as GitServiceError).message).toContain('no remote called "upstream"')
    expect((failure as GitServiceError).message).toContain('origin')
  })

  it('says so when there is nowhere to push at all', async () => {
    const repo = await repository()
    await repo.git(['checkout', '-q', '-b', 'feature'])

    const failure = await push(repo, 'feature').catch((error: unknown) => error)

    expect((failure as GitServiceError).message).toContain('no remotes')
  })

  it('refuses a remote name shaped like a flag', async () => {
    const repo = await repository({ withRemote: true })

    await expect(push(repo, 'main', '--upload-pack=touch /tmp/x')).rejects.toBeInstanceOf(GitServiceError)
  })
})
