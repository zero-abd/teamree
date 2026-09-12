// Throwaway repositories for the tests in this folder.
//
// Every test here drives the real git binary against a real repository in a
// temp directory. Mocking git would only prove that our idea of git is
// self-consistent, which is exactly the thing worth doubting.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGitRunner, type GitRunner } from './gitProcess'

export type TempRepo = {
  /** Temp directory holding the repo, its remote, and the worktrees root. */
  base: string
  repoPath: string
  worktreesRoot: string
  runner: GitRunner
  git(args: string[], cwd?: string): Promise<string>
  write(relativePath: string, content: string, cwd?: string): Promise<void>
  commit(message: string, cwd?: string): Promise<void>
  cleanup(): Promise<void>
}

export type TempRepoOptions = {
  /** Adds a bare `origin` with `origin/HEAD` pointing at main. */
  withRemote?: boolean
}

export async function createTempRepo(options: TempRepoOptions = {}): Promise<TempRepo> {
  // realpath first: macOS hands out /var/folders paths that git reports as
  // /private/var/folders, and the tests compare paths.
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'teamree-git-'))
  const repoPath = path.join(base, 'repo')
  const worktreesRoot = path.join(base, 'worktrees')
  await mkdir(repoPath, { recursive: true })

  const runner = createGitRunner()
  const git = async (args: string[], cwd = repoPath): Promise<string> => {
    const { stdout } = await runner.run({ args, cwd, timeoutMs: 60_000 })
    return stdout.trim()
  }

  await git(['init'])
  // `git init -b main` needs git 2.28; this works everywhere we support.
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(['config', 'user.name', 'Teamree Test'])
  await git(['config', 'user.email', 'test@teamree.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])

  const repo: TempRepo = {
    base,
    repoPath,
    worktreesRoot,
    runner,
    git,
    async write(relativePath, content, cwd = repoPath) {
      const target = path.join(cwd, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
    async commit(message, cwd = repoPath) {
      await git(['add', '--all'], cwd)
      await git(['commit', '--no-verify', '-m', message], cwd)
    },
    async cleanup() {
      await rm(base, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  await repo.write('README.md', '# fixture\n')
  await repo.commit('initial commit')

  if (options.withRemote) {
    const remotePath = path.join(base, 'origin.git')
    await git(['init', '--bare', remotePath], base)
    await git(['remote', 'add', 'origin', remotePath])
    await git(['push', '-u', 'origin', 'main'])
    await git(['remote', 'set-head', 'origin', '-a'])
  }

  return repo
}

/** Wraps a runner so one command is delayed, making cancellation deterministic. */
export function createDelayedRunner(
  inner: GitRunner,
  match: (args: readonly string[]) => boolean,
  delayMs: number
): GitRunner {
  const stall = async (args: readonly string[]): Promise<void> => {
    if (match(args)) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return {
    binary: inner.binary,
    async run(run) {
      await stall(run.args)
      return inner.run(run)
    },
    async tryRun(run) {
      await stall(run.args)
      return inner.tryRun(run)
    }
  }
}
