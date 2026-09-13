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

  const refspec = `refs/heads/${options.branch}:refs/heads/${options.branch}`
  // An explicit refspec, because `push.default` is a user setting and a push
  // that lands on a differently named branch because of one is a bad surprise.
  //
  // `--porcelain` is what makes the outcome readable rather than guessable: it
  // prints one line per ref whose first character is the result — `=` for a ref
  // the remote already had, `*` for a new one, a space for a fast-forward, `!`
  // for a rejection. git leaves those untranslated, unlike the prose on stderr
  // that used to be matched here.
  const pushed = await runner.tryRun({
    args: ['push', '--porcelain', ...(before === null ? ['--set-upstream'] : []), remote, refspec],
    cwd: options.worktreePath,
    timeoutMs: PUSH_TIMEOUT_MS,
    ...signal
  })
  const reported = parsePushStatus(pushed.stdout, refspec)

  if (pushed.exitCode !== 0) {
    throw new GitServiceError(ErrorCode.GitFailed, pushRefusal(pushed.stderr, remote, options.branch, reported))
  }

  return {
    worktreeId: options.worktreeId,
    remote,
    branch: options.branch,
    // The difference between "your work is on the remote now" and "your work
    // was already there", which a caller that cannot tell them apart reports
    // wrongly to somebody.
    alreadyUpToDate: reported?.flag === '=',
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

/** One `--porcelain` line: the result flag, and git's own word for why. */
export type PushRefStatus = { flag: string; summary: string }

/**
 * The line `--porcelain` printed for one refspec.
 *
 * The format is `<flag>\t<from>:<to>\t<summary>`, with the flag in column one
 * and `To <url>` and `Done` around the outside. Everything read here — the
 * flag, the refspec, and the parenthesised reason inside the summary — is
 * fixed text git does not translate, which is the whole reason for asking in
 * this form.
 */
export function parsePushStatus(stdout: string, refspec: string): PushRefStatus | null {
  for (const line of stdout.split('\n')) {
    const withoutFlag = line.slice(1)
    if (!withoutFlag.startsWith(`\t${refspec}\t`)) continue
    return { flag: line[0] ?? '', summary: withoutFlag.slice(refspec.length + 2) }
  }
  return null
}

/**
 * Turns git's refusal into something worth reading.
 *
 * The rejection that matters is a non-fast-forward: the remote has commits this
 * branch does not, and the fix is to bring them in — never to force, which is
 * exactly what the message git prints suggests to a reader in a hurry.
 *
 * `reported` is the porcelain line for the ref, when there is one. It decides
 * first, because it says the same thing in a form that survives a translated
 * git; the prose on stderr is what is left when git refused before it ever got
 * as far as a ref.
 */
export function pushRefusal(stderr: string, remote: string, branch: string, reported?: PushRefStatus | null): string {
  const text = stderr.trim()
  if (reported?.flag === '!' && /non-fast-forward|fetch first|stale info/i.test(reported.summary)) {
    return `${remote} has commits that ${branch} does not. Pull or rebase onto ${remote}/${branch} and push again.`
  }
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
