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
//
// And it says where the work can now be read. A push is the moment a review
// becomes possible, and the page that starts one is derivable from the remote's
// URL — see `reviewUrl.ts`, which guesses at nothing and asks the forge nothing.

import type { PushFailureKind, WorktreePush } from '../../shared/entities'
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
  /**
   * The project's base ref, for the review page this push makes available.
   * Absent — a worktree whose project has gone — and no review URL is offered,
   * because there is nothing to say what the branch would be reviewed against.
   */
  baseRef?: string
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

  const review = await reviewPage(runner, options, remote)

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
    ...(review === undefined ? {} : { reviewUrl: review }),
    pushedAt: (options.now ?? Date.now)()
  }
}

/**
 * The page a reviewer would read this branch on, when there is one.
 *
 * Read from the remote's fetch URL rather than its push URL: the push URL is
 * the address this machine writes through, which a mirror or a proxy can make
 * something nobody browses, while the fetch URL is the address the remote is
 * known by. Nothing here fails a push — a remote whose URL cannot be read, or
 * whose host means nothing to this app, simply leaves the field off.
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
 * What kind of thing went wrong, for a caller that has to do more than print it.
 *
 * A string of git's is the right thing to *show*; it is the wrong thing to
 * branch on, and a panel that wants to offer "pull and try again" on one
 * failure and "this is not something retrying will fix" on another needs the
 * shape of the refusal rather than its prose.
 *
 * `PushFailureKind` is declared in `shared/entities` because it crosses the
 * wire. Two of its cases are missing from what this function can decide —
 * `cancelled` and `timeout` — because neither of them is something git said.
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
 *
 * The authentication cases used to end in "check that this machine can write to
 * it", which is a diagnosis wearing the clothes of a remedy. They are the
 * failures a person is least able to work out for themselves — this app runs
 * git with no terminal to prompt on, so a machine that would have asked for a
 * password simply refuses — so each one now names the command that fixes it.
 */
export function pushRefusal(stderr: string, remote: string, branch: string, reported?: PushRefStatus | null): string {
  const text = stderr.trim()
  switch (pushFailureKind(text, reported)) {
    case 'rejected':
      return `${remote} has commits that ${branch} does not. Pull or rebase onto ${remote}/${branch} and push again.`
    case 'host-key':
      return (
        `ssh has never accepted the host key for ${remote} and will not guess at one. Run ssh against that host ` +
        'once in Terminal, accept the key, and push again.'
      )
    case 'auth':
      return `${remote} refused the push: ${firstLine(text)}. ${authRemedy(text)}`
    default:
      return firstLine(text) || `could not push ${branch} to ${remote}`
  }
}

/**
 * The one thing to do about a push that was not allowed, on this platform.
 *
 * teamree is macOS-only, so these are allowed to be specific: the keychain
 * helper is the one that ships, and `--apple-use-keychain` is the flag that
 * makes an added key survive a reboot. Which of the two applies is read out of
 * what git said rather than out of the remote's URL, because it is git that
 * knows which transport it actually tried — and the general sentence is kept
 * for everything else, rather than a guess dressed as an instruction.
 */
function authRemedy(stderr: string): string {
  if (/could not read (username|password)|terminal prompts disabled/i.test(stderr)) {
    return (
      'git wanted a username and password, and teamree runs git with no terminal to ask on. Store them once with ' +
      'git config --global credential.helper osxkeychain and push from Terminal, or point origin at an ssh URL.'
    )
  }
  if (/permission denied \(publickey|publickey,|no supported authentication/i.test(stderr)) {
    return (
      'ssh offered no key the remote accepts. Add yours with ssh-add --apple-use-keychain, and check that this ' +
      'account has push access to the repository.'
    )
  }
  return 'Check that this account has push access to the repository, and that this machine holds a credential for it.'
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('To '))[0] ?? ''
  )
}
