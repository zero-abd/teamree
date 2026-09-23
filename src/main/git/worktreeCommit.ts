// Committing from inside the app: the first thing here that writes to a
// repository, so it refuses rather than guesses. Nothing is staged on the caller's
// behalf; a conflicted tree, an empty commit and a git with no identity are refused.

import type { WorktreeCommit } from '../../shared/entities'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { ErrorCode } from '../../shared/protocol'
import { parseChangeRecords } from './worktreeChanges'

/** Hooks run, and a hook can be slow; this is the ceiling before one is killed. */
const COMMIT_TIMEOUT_MS = 120_000

export type CommitOptions = {
  worktreeId: string
  worktreePath: string
  message: string
  /** Paths to stage before committing. Omitted means commit what is already staged — never everything. */
  paths?: readonly string[]
  signal?: AbortSignal
  now?: () => number
}

export async function commitWorktree(runner: GitRunner, options: CommitOptions): Promise<WorktreeCommit> {
  const message = options.message.trim()
  if (message.length === 0) {
    throw new GitServiceError(ErrorCode.InvalidParams, 'a commit needs a message')
  }

  const run = { cwd: options.worktreePath, timeoutMs: COMMIT_TIMEOUT_MS } as const
  const signal = options.signal ? { signal: options.signal } : {}

  await requireCommitIdentity(runner, options.worktreePath, options.signal)

  const before = await readStatus(runner, options.worktreePath, options.signal)
  const conflicted = before.filter((change) => change.kind === 'conflicted').map((change) => change.path)
  if (conflicted.length > 0) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      `resolve the conflict${conflicted.length === 1 ? '' : 's'} first: ${conflicted.join(', ')}`
    )
  }

  if (options.paths && options.paths.length > 0) {
    // `--` first, so a path that looks like a flag or a ref is still a path.
    await runner.run({ args: ['add', '--', ...options.paths], ...run, ...signal })
  }

  const staged = (await readStatus(runner, options.worktreePath, options.signal)).filter((change) => change.staged)
  if (staged.length === 0) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      options.paths && options.paths.length > 0
        ? 'those paths have nothing staged to commit'
        : 'nothing is staged; name the paths to commit, or stage them first'
    )
  }

  await runner.run({ args: ['commit', '-m', message], ...run, ...signal })

  const { stdout } = await runner.run({
    args: ['rev-parse', 'HEAD'],
    cwd: options.worktreePath,
    readOnly: true,
    ...signal
  })
  const sha = stdout.trim()

  return {
    worktreeId: options.worktreeId,
    sha,
    shortSha: sha.slice(0, 7),
    message,
    // What this commit actually captured: a path already staged from an earlier
    // edit goes in too.
    paths: staged.map((change) => change.path).sort(),
    committedAt: (options.now ?? Date.now)()
  }
}

/**
 * Refuses before anything is staged when git has no identity. Otherwise the
 * commit fails at the last step with "Author identity unknown", after staging and
 * a typed message. `git var` resolves the ident exactly as `commit` does, so this
 * cannot disagree with it. Never sets one: whose name a commit carries is the user's to say.
 */
export async function requireCommitIdentity(
  runner: GitRunner,
  worktreePath: string,
  signal?: AbortSignal
): Promise<void> {
  const { exitCode } = await runner.tryRun({
    args: ['var', 'GIT_AUTHOR_IDENT'],
    cwd: worktreePath,
    readOnly: true,
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000
  })
  if (exitCode === 0) return

  throw new GitServiceError(
    ErrorCode.Conflict,
    'git does not know who you are, so it will not write a commit. Set a name and an email once, ' +
      'in a terminal: git config --global user.name "Your Name" and ' +
      'git config --global user.email "you@example.com".'
  )
}

async function readStatus(
  runner: GitRunner,
  worktreePath: string,
  signal?: AbortSignal
): Promise<ReturnType<typeof parseChangeRecords>> {
  // `--untracked-files=normal` is pinned: `status.showUntrackedFiles=no` in
  // ~/.gitconfig would otherwise answer "nothing untracked" for a checkout whose
  // status chip, which pins the flag, says otherwise.
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z', '--untracked-files=normal'],
    cwd: worktreePath,
    readOnly: true,
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000
  })
  return parseChangeRecords(stdout)
}
