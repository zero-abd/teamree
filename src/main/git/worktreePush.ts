// Pushing a worktree's branch to its remote. Never force-pushes, reports what
// it did rather than what it attempted, and leaves the branch tracking the
// branch it just wrote (see `tracksSomethingElse`).

import type { PushFailureData, PushFailureKind, WorktreePush } from '../../shared/entities'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { ErrorCode } from '../../shared/protocol'
import { assertRefShape } from './repository'
import { reviewUrl } from './reviewUrl'
import { parseChangeRecords } from './worktreeChanges'

/** A push crosses a network, so it gets far longer than a local command. */
const PUSH_TIMEOUT_MS = 10 * 60_000

export type PushOptions = {
  worktreeId: string
  worktreePath: string
  branch: string
  /** Defaults to `origin`, the only remote most repositories have. */
  remote?: string
  /** The project's base ref, for the review URL; absent, no review URL is offered. */
  baseRef?: string
  signal?: AbortSignal
  now?: () => number
}

export async function pushWorktree(runner: GitRunner, options: PushOptions): Promise<WorktreePush> {
  const remote = options.remote ?? 'origin'
  // Not through a shell, but a name shaped like a flag would still be read as one.
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
    throw refused(
      ErrorCode.NotFound,
      known.length === 0 ? 'no remote' : `${remote} not found`,
      known.length === 0
        ? `this repository has no remotes; add one before pushing`
        : `no remote called "${remote}"; this repository has ${known.join(', ')}`
    )
  }

  const status = await runner.run({ args: ['status', '--porcelain=v2', '-z'], ...read, ...signal })
  const uncommitted = parseChangeRecords(status.stdout).filter((change) => change.kind !== 'untracked').length

  const before = await upstreamOf(runner, options.worktreePath, options.branch, options.signal)
  const claiming = tracksSomethingElse(before, remote, options.branch, options.baseRef)

  const refspec = `refs/heads/${options.branch}:refs/heads/${options.branch}`
  // An explicit refspec, because `push.default` is a user setting. `--porcelain`
  // prints one untranslated line per ref whose first character is the result:
  // `=` already had, `*` new, a space for a fast-forward, `!` for a rejection.
  const pushed = await runner.tryRun({
    args: ['push', '--porcelain', ...(claiming ? ['--set-upstream'] : []), remote, refspec],
    cwd: options.worktreePath,
    timeoutMs: PUSH_TIMEOUT_MS,
    ...signal
  })
  const reported = parsePushStatus(pushed.stdout, refspec)

  if (pushed.exitCode !== 0) {
    // With `--porcelain` the ref's own refusal is on stdout; the detail keeps it beside stderr.
    const said = [reported?.flag === '!' ? `${options.branch}: ${reported.summary}` : '', pushed.stderr.trim()]
      .filter(Boolean)
      .join('\n')
    throw refused(
      ErrorCode.GitFailed,
      pushFailureLabel(pushed.stderr, reported, remote),
      said || `could not push ${options.branch}`
    )
  }

  const review = await reviewPage(runner, options, remote)

  // Read rather than assumed: `origin/<branch>` because the flag was passed,
  // rather than because git wrote the config, would describe a thing that had not happened.
  const after = await upstreamOf(runner, options.worktreePath, options.branch, options.signal)

  return {
    worktreeId: options.worktreeId,
    remote,
    branch: options.branch,
    // "Your work is on the remote now" versus "your work was already there".
    alreadyUpToDate: reported?.flag === '=',
    upstream: after ?? before ?? `${remote}/${options.branch}`,
    setUpstream: after !== null && after !== before,
    uncommitted,
    ...(review === undefined ? {} : { reviewUrl: review }),
    pushedAt: (options.now ?? Date.now)()
  }
}

/**
 * The page a reviewer would read this branch on, when there is one. Read from
 * the fetch URL, not the push URL a mirror or proxy can make unbrowsable. Never fails a push.
 */
async function reviewPage(runner: GitRunner, options: PushOptions, remote: string): Promise<string | undefined> {
  if (options.baseRef === undefined) return undefined
  const url = await runner.tryRun({
    args: ['remote', 'get-url', remote],
    cwd: options.worktreePath,
    readOnly: true,
    timeoutMs: 30_000,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (url.exitCode !== 0) return undefined
  return reviewUrl({
    remoteUrl: url.stdout.trim(),
    branch: options.branch,
    baseRef: options.baseRef,
    remote
  })
}

/**
 * Whether this push decides what the branch tracks: only a branch tracking nothing,
 * or one still tracking the base ref it was cut from (which made `ahead` count a
 * commit the remote already had). Any other upstream is a person's choice.
 */
function tracksSomethingElse(
  upstream: string | null,
  remote: string,
  branch: string,
  baseRef: string | undefined
): boolean {
  if (upstream === null) return true
  if (upstream === `${remote}/${branch}`) return false
  if (baseRef === undefined) return false
  // A base ref is usually remote-qualified (`origin/main`); a project with no
  // remote names a local branch, and `origin/<that>` is the same thing by its other name.
  return upstream === baseRef || upstream === `${remote}/${baseRef}`
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
 * The `--porcelain` line for one refspec: `<flag>\t<from>:<to>\t<summary>`, with
 * `To <url>` and `Done` around the outside. All fixed text git does not translate.
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
 * What kind of thing went wrong, for a caller that has to branch on it rather than print it.
 * `cancelled` and `timeout` are not decided here because neither is something git said.
 */
export function pushFailureKind(stderr: string, reported?: PushRefStatus | null): PushFailureKind {
  const text = stderr.trim()
  if (reported?.flag === '!' && /non-fast-forward|fetch first|stale info/i.test(reported.summary)) return 'rejected'
  if (/non-fast-forward|fetch first|rejected/i.test(text)) return 'rejected'
  if (/host key verification failed|host key for .* has changed|remote host identification/i.test(text)) {
    return 'host-key'
  }
  if (
    /could not read|terminal prompts disabled|authentication|permission denied|access rights|403|repository not found/i.test(
      text
    )
  ) {
    return 'auth'
  }
  return 'other'
}

const OFFLINE =
  /could not resolve host|network is unreachable|no route to host|connection (timed out|refused)|operation timed out|failed to connect to|name resolution/i

/**
 * The clause after "Push failed:" in the Changes tab, or `Push failed` itself when git gave none.
 * A missing remote also fails git's read, so it goes first.
 */
export function pushFailureLabel(stderr: string, reported?: PushRefStatus | null, remote = 'remote'): string {
  const behind = /non-fast-forward|fetch first|stale info/i
  if (behind.test(stderr) || (reported?.flag === '!' && behind.test(reported.summary))) return 'remote is ahead'
  const kind = pushFailureKind(stderr, reported)
  if (kind === 'rejected') return 'rejected by remote'
  if (/does not appear to be a git repository|repository not found|no such remote/i.test(stderr))
    return `${remote} not found`
  if (OFFLINE.test(stderr)) return 'offline'
  if (kind === 'auth') return 'sign-in failed'
  if (kind === 'host-key') return 'unknown host key'
  return 'Push failed'
}

function refused(code: ErrorCode, label: string, detail: string): GitServiceError {
  const data: PushFailureData = { detail }
  return new GitServiceError(code, label, data)
}

/**
 * Turns git's refusal into something worth reading. The porcelain line decides
 * first because it survives a translated git; stderr is what is left when git
 * refused before reaching a ref. Auth failures name the command that fixes them.
 */
export function pushRefusal(stderr: string, remote: string, branch: string, reported?: PushRefStatus | null): string {
  const text = stderr.trim()
  switch (pushFailureKind(text, reported)) {
    case 'rejected':
      return `${remote} has commits that ${branch} does not · pull or rebase onto ${remote}/${branch}`
    case 'host-key':
      return `Unknown ssh host key for ${remote} · accept it once in Terminal`
    case 'auth':
      return `${remote} refused the push: ${firstLine(text).replace(/\.$/, '')} · ${authRemedy(text)}`
    default:
      return firstLine(text) || `could not push ${branch} to ${remote}`
  }
}

/**
 * The one thing to do about a push that was not allowed. macOS-only, so the
 * keychain helper and `--apple-use-keychain` are specific; which applies is read
 * from what git said, since git knows which transport it tried.
 */
function authRemedy(stderr: string): string {
  if (/could not read (username|password)|terminal prompts disabled/i.test(stderr)) {
    return 'no terminal for a password prompt; git config --global credential.helper osxkeychain, or use an ssh URL'
  }
  if (/permission denied \(publickey|publickey,|no supported authentication/i.test(stderr)) {
    return 'no ssh key accepted; ssh-add --apple-use-keychain, and check push access'
  }
  return 'check push access and this machine’s credential'
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('To '))[0] ?? ''
  )
}
