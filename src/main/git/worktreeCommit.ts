// Committing from inside the app.
//
// This is the first thing here that writes to a repository, so it is built to
// refuse rather than to guess. Everything else in this folder answers
// questions; a bad answer is a wrong chip. A bad commit is in the history.
//
// Four refusals shape it:
//
//   - Nothing is ever staged on the caller's behalf. Passing paths stages those
//     paths and nothing else; passing none commits what the user already
//     staged. There is no "commit everything", because the thing a sweep picks
//     up that nobody wanted is exactly the thing you find out about later.
//   - A worktree with unmerged paths is refused outright. Committing a
//     conflicted tree writes the conflict markers into the history as if they
//     were code.
//   - An empty commit is refused, because it is almost always a sign that the
//     paths named were not the paths that changed.
//   - A machine whose git has no identity is refused before anything is staged,
//     because the alternative is a wall of git's own prose at the last step of
//     a commit the user has already composed.

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
  /**
   * Paths to stage before committing. Omitted means commit what is already
   * staged — never everything, which is a different and much less careful act.
   */
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
    // What this commit actually captured, which is not always what was asked
    // for: a path already staged from an earlier edit goes in too, and saying
    // so is the difference between a report and a guess.
    paths: staged.map((change) => change.path).sort(),
    committedAt: (options.now ?? Date.now)()
  }
}

/**
 * Refuses before anything is staged when git has no identity to sign with.
 *
 * This is the fourth refusal, and the only one whose cause is the machine
 * rather than the tree: git is installed, `git config --global user.email` was
 * never run, and the commit fails at the last step with "Author identity
 * unknown" — after the paths have been staged, and after the user has typed a
 * message. Asked first, nothing has moved when the refusal arrives, and the
 * answer is the same one git's own `commit` would have reached: `git var`
 * resolves the ident through env, local, global and system config exactly as a
 * commit does, so this cannot disagree with the command it stands in front of.
 *
 * It does not set the identity. Whose name a commit carries is the user's to
 * say, and a tool that picks one for them has forged the history of the
 * repository rather than helped.
 */
async function requireCommitIdentity(runner: GitRunner, worktreePath: string, signal?: AbortSignal): Promise<void> {
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
  const { stdout } = await runner.run({
    args: ['status', '--porcelain=v2', '-z'],
    cwd: worktreePath,
    readOnly: true,
    ...(signal ? { signal } : {}),
    timeoutMs: 30_000
  })
  return parseChangeRecords(stdout)
}
