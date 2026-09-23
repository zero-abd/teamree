// Committing on a machine where git has never been configured: the refusal has
// to be a sentence they can act on, before staging is spent.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { createGitRunner, type GitRun, type GitRunner } from './gitProcess'
import { commitWorktree } from './worktreeCommit'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A repository on a machine that has never been told who its user is, and may not guess. */
async function unconfiguredRepo(): Promise<{ repoPath: string; runner: GitRunner }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-identity-'))
  created.push(base)
  const home = path.join(base, 'home')
  const repoPath = path.join(base, 'repo')
  await mkdir(home, { recursive: true })
  await mkdir(repoPath, { recursive: true })

  const blank: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    // Files that do not exist: how git spells "there is no config here".
    GIT_CONFIG_GLOBAL: path.join(home, 'no-global-config'),
    GIT_CONFIG_SYSTEM: path.join(home, 'no-system-config'),
    // An identity in the suite runner's environment would outrank every file above.
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    EMAIL: undefined,
    // With nothing configured git invents an identity from the account name and
    // hostname, which fails in a container and succeeds on macOS CI; "never guess".
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.useConfigOnly',
    GIT_CONFIG_VALUE_0: 'true'
  }
  const real = createGitRunner()
  const withBlankIdentity = (run: GitRun): GitRun => ({ ...run, env: { ...run.env, ...blank } })
  const runner: GitRunner = {
    binary: real.binary,
    run: (run) => real.run(withBlankIdentity(run)),
    tryRun: (run) => real.tryRun(withBlankIdentity(run))
  }

  await runner.run({ args: ['init'], cwd: repoPath })
  await runner.run({ args: ['symbolic-ref', 'HEAD', 'refs/heads/main'], cwd: repoPath })
  return { repoPath, runner }
}

describe('committing before git knows who you are', () => {
  it('says what to do about it, instead of handing back git exit code 128', async () => {
    const { repoPath, runner } = await unconfiguredRepo()
    await writeFile(path.join(repoPath, 'work.txt'), 'a morning of work\n')

    const failure = await commitWorktree(runner, {
      worktreeId: 'wt',
      worktreePath: repoPath,
      message: 'the first commit on this machine',
      paths: ['work.txt']
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GitServiceError)
    expect((failure as GitServiceError).code).toBe(ErrorCode.Conflict)
    const message = (failure as Error).message
    expect(message).toContain('git does not know who you are')
    // The two commands, spelled out.
    expect(message).toContain('git config --global user.name')
    expect(message).toContain('git config --global user.email')
  })

  it('refuses before it stages anything, so nothing is left half-done', async () => {
    const { repoPath, runner } = await unconfiguredRepo()
    await writeFile(path.join(repoPath, 'work.txt'), 'a morning of work\n')

    await commitWorktree(runner, {
      worktreeId: 'wt',
      worktreePath: repoPath,
      message: 'the first commit on this machine',
      paths: ['work.txt']
    }).catch(() => undefined)

    // Still untracked: the refusal came before `git add`.
    const { stdout } = await runner.run({ args: ['status', '--porcelain'], cwd: repoPath, readOnly: true })
    expect(stdout).toContain('?? work.txt')
  })

  it('commits as normal once an identity exists', async () => {
    const { repoPath, runner } = await unconfiguredRepo()
    await runner.run({ args: ['config', 'user.name', 'Teamree Test'], cwd: repoPath })
    await runner.run({ args: ['config', 'user.email', 'test@teamree.invalid'], cwd: repoPath })
    await runner.run({ args: ['config', 'commit.gpgsign', 'false'], cwd: repoPath })
    await writeFile(path.join(repoPath, 'work.txt'), 'a morning of work\n')

    const commit = await commitWorktree(runner, {
      worktreeId: 'wt',
      worktreePath: repoPath,
      message: 'the first commit on this machine',
      paths: ['work.txt']
    })

    expect(commit.paths).toEqual(['work.txt'])
    expect(commit.shortSha).toBe(commit.sha.slice(0, 7))
  })
})
