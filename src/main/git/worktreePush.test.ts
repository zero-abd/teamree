import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { createTempRepo, type TempRepo } from './testRepository'
import { parsePushStatus, pushFailureKind, pushRefusal, pushWorktree } from './worktreePush'

describe('parsePushStatus', () => {
  const refspec = 'refs/heads/work:refs/heads/work'

  it('reads the result flag rather than the sentence beside it', () => {
    expect(parsePushStatus(`To /tmp/o.git\n=\t${refspec}\t[up to date]\nDone\n`, refspec)).toEqual({
      flag: '=',
      summary: '[up to date]'
    })
    expect(parsePushStatus(`To /tmp/o.git\n*\t${refspec}\t[new branch]\nDone\n`, refspec)?.flag).toBe('*')
    // A fast-forward's flag is a space, which is still a flag.
    expect(parsePushStatus(`To /tmp/o.git\n \t${refspec}\tabc123..def456\nDone\n`, refspec)?.flag).toBe(' ')
  })

  it('ignores lines about some other ref', () => {
    const other = 'refs/heads/elsewhere:refs/heads/elsewhere'
    expect(parsePushStatus(`To /tmp/o.git\n=\t${other}\t[up to date]\nDone\n`, refspec)).toBeNull()
  })

  it('says nothing rather than guessing when git printed no line for the ref', () => {
    expect(parsePushStatus('', refspec)).toBeNull()
  })
})

describe('pushRefusal', () => {
  // git's message for this suggests forcing to a reader in a hurry.
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

  // The prose is git's; the porcelain flag is not, and survives a translated git.
  it('explains a rejection from the porcelain flag when the prose is not English', () => {
    const message = pushRefusal('Fehler: Push einiger Referenzen nach ... fehlgeschlagen', 'origin', 'main', {
      flag: '!',
      summary: '[rejected] (non-fast-forward)'
    })

    expect(message).toContain('origin has commits that main does not')
  })

  // The app runs git with no terminal to prompt on, so a machine that would have
  // asked for a password simply refuses; each shape of refusal names the fix.
  it('says when the remote would not let this machine in, and what to do about it', () => {
    const general = pushRefusal('fatal: Authentication failed for https://example.invalid/x.git', 'origin', 'work')
    expect(general).toContain('fatal: Authentication failed')
    expect(general).toContain('Check that this account has push access')

    expect(
      pushRefusal("fatal: could not read Username for 'https://x': terminal prompts disabled", 'origin', 'work')
    ).toContain('credential.helper osxkeychain')

    expect(pushRefusal('git@example.invalid: Permission denied (publickey).', 'origin', 'work')).toContain(
      'ssh-add --apple-use-keychain'
    )
  })

  // ssh refusing a host it has never met is neither a credential nor a rejection.
  it('says when ssh has never accepted the host key, rather than blaming the account', () => {
    const message = pushRefusal('Host key verification failed.', 'origin', 'work')
    expect(message).toContain('never accepted the host key')
    expect(message).not.toContain('push access')
  })

  // The shape of the refusal is reported separately from its prose.
  it('reports the shape of the refusal, for a caller that has to do more than print it', () => {
    expect(pushFailureKind('', { flag: '!', summary: '[rejected] (non-fast-forward)' })).toBe('rejected')
    expect(pushFailureKind('fatal: Authentication failed')).toBe('auth')
    expect(pushFailureKind('Host key verification failed.')).toBe('host-key')
    expect(pushFailureKind('fatal: the remote end hung up unexpectedly')).toBe('other')
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

  // "Everything up-to-date" and "pushed four commits" are different outcomes.
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

  // This is the one prose match in the app that failed unsafe: a miss reported
  // a push that sent nothing as a push that sent the work.
  it('reads "nothing was sent" from the result flag, not from git’s wording', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')
    await push(repo, 'feature')

    // A git that speaks anything but English, answering the same question.
    const translated: GitRunner = {
      binary: repo.runner.binary,
      run: (options) => repo.runner.run(options),
      async tryRun(options) {
        const result = await repo.runner.tryRun(options)
        return options.args[0] === 'push' ? { ...result, stderr: 'Alles aktuell\n' } : result
      }
    }

    const result = await pushWorktree(translated, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch: 'feature',
      now: () => 777
    })

    expect(result.alreadyUpToDate).toBe(true)
  })

  it('counts the work left behind rather than refusing to push over it', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('committed.ts', 'export const a = 1\n')
    await repo.commit('committed work')
    await repo.write('committed.ts', 'export const a = 2\n')
    await repo.write('untracked.log', 'noise\n')

    const result = await push(repo, 'feature')

    // The edit counts; the stray log was never going to be part of a push.
    expect(result.uncommitted).toBe(1)
    expect(result.alreadyUpToDate).toBe(false)
  })

  it('explains a rejected push instead of leaving git’s wording', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'one\n')
    await repo.commit('first')
    await push(repo, 'feature')

    // Somebody else moves the remote on, then this side rewrites its history.
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

  // A local bare repository as remote, whose `url` is the address the repository
  // is known by — what a mirror or proxy produces. `pushurl` keeps commits local.
  it('names the review page from the URL the remote is known by', async () => {
    const repo = await repository({ withRemote: true })
    const bare = await repo.git(['remote', 'get-url', 'origin'])
    await repo.git(['config', 'remote.origin.pushurl', bare])
    await repo.git(['config', 'remote.origin.url', 'git@github.com:o/r.git'])
    await repo.git(['checkout', '-q', '-b', 'feature/login'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')

    const result = await pushWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch: 'feature/login',
      baseRef: 'origin/main',
      now: () => 777
    })

    expect(result.reviewUrl).toBe('https://github.com/o/r/compare/main...feature%2Flogin?expand=1')
    // Still a real push, to the bare repository beside this one — asked of that
    // path, since `origin`'s fetch URL now names a host no test may go near.
    expect(await repo.git(['ls-remote', '--heads', bare, 'feature/login'])).toContain('refs/heads/feature/login')
  })

  // A path is not a forge, and a push to one is still a push.
  it('offers no review page for a remote that is a directory', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')

    const result = await pushWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch: 'feature',
      baseRef: 'origin/main',
      now: () => 777
    })

    expect(result.reviewUrl).toBeUndefined()
    expect(result.alreadyUpToDate).toBe(false)
  })

  // Nothing said which branch a review would be against, so nothing is offered.
  it('offers no review page when no base ref was given', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['config', 'remote.origin.pushurl', await repo.git(['remote', 'get-url', 'origin'])])
    await repo.git(['config', 'remote.origin.url', 'git@github.com:o/r.git'])
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')

    expect((await push(repo, 'feature')).reviewUrl).toBeUndefined()
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

  // git hands a worktree branch the base ref as upstream, and `ahead` is measured
  // against the upstream, so the button says a commit is left to send, forever.
  it('points the branch at its own branch on the remote, not at the base it was cut from', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    // Exactly what `worktree add --track origin/main` leaves behind.
    await repo.git(['branch', '--set-upstream-to=origin/main', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')

    const result = await pushWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch: 'feature',
      baseRef: 'origin/main',
      now: () => 777
    })

    expect(await repo.git(['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).toBe('origin/feature')
    // And the result says so: the fields claimed tracking this call had not touched.
    expect(result.upstream).toBe('origin/feature')
    expect(result.setUpstream).toBe(true)
    // Nothing else moved: the base is still two commits away if it was.
    expect(result.alreadyUpToDate).toBe(false)
  })

  // Re-pointing an upstream already right would be a write for nothing.
  it('leaves a branch that already tracks its own branch on the remote alone', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')
    await repo.git(['push', '-u', 'origin', 'refs/heads/feature:refs/heads/feature'])

    const pushes: string[][] = []
    const recording: GitRunner = {
      binary: repo.runner.binary,
      run: (options) => repo.runner.run(options),
      async tryRun(options) {
        if (options.args[0] === 'push') pushes.push([...options.args])
        return repo.runner.tryRun(options)
      }
    }

    const result = await pushWorktree(recording, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch: 'feature',
      baseRef: 'origin/main',
      now: () => 777
    })

    expect(pushes[0]).not.toContain('--set-upstream')
    expect(result.setUpstream).toBe(false)
    expect(result.upstream).toBe('origin/feature')
    expect(result.alreadyUpToDate).toBe(true)
  })

  // The base ref is the one upstream no person chose.
  it('leaves an upstream somebody chose deliberately where they put it', async () => {
    const repo = await repository({ withRemote: true })
    await repo.git(['checkout', '-q', '-b', 'feature'])
    await repo.write('work.ts', 'export const a = 1\n')
    await repo.commit('some work')
    await repo.git(['push', 'origin', 'refs/heads/feature:refs/heads/elsewhere'])
    await repo.git(['branch', '--set-upstream-to=origin/elsewhere', 'feature'])

    const result = await pushWorktree(repo.runner, {
      worktreeId: 'wt',
      worktreePath: repo.repoPath,
      branch: 'feature',
      baseRef: 'origin/main',
      now: () => 777
    })

    expect(await repo.git(['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).toBe('origin/elsewhere')
    expect(result.upstream).toBe('origin/elsewhere')
    expect(result.setUpstream).toBe(false)
  })

  it('refuses a remote name shaped like a flag', async () => {
    const repo = await repository({ withRemote: true })

    await expect(push(repo, 'main', '--upload-pack=touch /tmp/x')).rejects.toBeInstanceOf(GitServiceError)
  })
})
