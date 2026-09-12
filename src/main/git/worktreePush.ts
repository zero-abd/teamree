// Pushing a worktree's branch to its remote.
//
// The one thing here that leaves the machine. That shapes it in three ways.
//
// It never force-pushes. There is no flag for it and no way to ask: the whole
// value of a force push is overwriting someone else's history, and a button
// that can do that from a sidebar is a button that eventually does.
//
// It says what it did rather than what it attempted. "Everything up-to-date" is
// a different outcome from "pushed four commits", and a caller that cannot tell
// them apart will report the wrong thing to someone.
//
// It reports uncommitted work rather than blocking on it. Pushing commits while
// still editing is ordinary, and refusing would be wrong — but what lands is
// then not what the user is looking at, and that is worth saying out loud.

import type { WorktreePush } from '../../shared/entities'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { ErrorCode } from '../../shared/protocol'
import { assertRefShape } from './repository'
import { parseChangeRecords } from './worktreeChanges'

/** A push crosses a network, so it gets far longer than a local command. */
const PUSH_TIMEOUT_MS = 10 * 60_000

export type PushOptions = {
  worktreeId: string
  worktreePath: string
  branch: string
  /** Defaults to `origin`, the only remote most repositories have. */
  remote?: string
  signal?: AbortSignal
  now?: () => number
}

export async function pushWorktree(runner: GitRunner, options: PushOptions): Promise<WorktreePush> {
  const remote = options.remote ?? 'origin'
  // The remote name reaches git as an argument, not through a shell, but a name
  // shaped like a flag or an option would still be read as one.
  assertRefShape(remote, 'remote')
  assertRefShape(options.branch, 'branch')

  const read = { cwd: options.worktreePath, readOnly: true, timeoutMs: 30_000 } as const
  const signal = options.signal ? { signal: options.signal } : {}

  const remotes = await runner.run({ args: ['remote'], ...read, ...signal })
  const known = remotes.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!known.includes(remote)) {
    throw new GitServiceError(
      ErrorCode.NotFound,
      known.length === 0
        ? `this repository has no remotes; add one before pushing`
        : `no remote called "${remote}"; this repository has ${known.join(', ')}`
    )
  }

  const status = await runner.run({ args: ['status', '--porcelain=v2', '-z'], ...read, ...signal })
  const uncommitted = parseChangeRecords(status.stdout).filter((change) => change.kind !== 'untracked').length

  const before = await upstreamOf(runner, options.worktreePath, options.branch, options.signal)

  // An explicit refspec, because `push.default` is a user setting and a push
  // that lands on a differently named branch because of one is a bad surprise.
  const pushed = await runner.tryRun({
    args: [
      'push',
      ...(before === null ? ['--set-upstream'] : []),
      remote,
      `refs/heads/${options.branch}:refs/heads/${options.branch}`
    ],
    cwd: options.worktreePath,
    timeoutMs: PUSH_TIMEOUT_MS,
    ...signal
  })

  if (pushed.exitCode !== 0) {
    throw new GitServiceError(ErrorCode.GitFailed, pushRefusal(pushed.stderr, remote, options.branch))
  }

  return {
    worktreeId: options.worktreeId,
    remote,
    branch: options.branch,
    // git says this on stderr, and it is the difference between "your work is
    // on the remote now" and "your work was already there".
    alreadyUpToDate: /everything up-to-date/i.test(pushed.stderr),
    upstream:
      (await upstreamOf(runner, options.worktreePath, options.branch, options.signal)) ?? `${remote}/${options.branch}`,
    setUpstream: before === null,
    uncommitted,
    pushedAt: (options.now ?? Date.now)()
  }
}

/** What the branch already tracks, or null when it tracks nothing. */
async function upstreamOf(
  runner: GitRunner,
  worktreePath: string,
  branch: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await runner.tryRun({
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
    cwd: worktreePath,
    readOnly: true,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {})
  })
  const name = result.stdout.trim()
  return result.exitCode === 0 && name.length > 0 ? name : null
}

/**
 * Turns git's refusal into something worth reading.
 *
 * The rejection that matters is a non-fast-forward: the remote has commits this
 * branch does not, and the fix is to bring them in — never to force, which is
 * exactly what the message git prints suggests to a reader in a hurry.
 */
export function pushRefusal(stderr: string, remote: string, branch: string): string {
  const text = stderr.trim()
  if (/non-fast-forward|fetch first|rejected/i.test(text)) {
    return `${remote} has commits that ${branch} does not. Pull or rebase onto ${remote}/${branch} and push again.`
  }
  if (/could not read|authentication|permission denied|access rights/i.test(text)) {
    return `${remote} refused the push: ${firstLine(text)}. Check that this machine can write to it.`
  }
  return firstLine(text) || `could not push ${branch} to ${remote}`
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('To '))[0] ?? ''
  )
}
