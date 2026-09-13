// The one step teamree used to refuse: committing the two files and pushing them.
//
// The refusal was right about why and wrong about what to do. Being able to
// push `.teamree/members/<you>.pub` is the whole of what membership means, so a
// key this app pushed silently would be a claim the user never made — but the
// answer to that is consent, not a wall of shell commands in a panel inside an
// app that owns terminals and git. So this says exactly what it will do first
// (`readPublishPlan`) and then does exactly that and nothing else.
//
// Three refusals shape it, and they are the same shape as `worktreeCommit`'s:
//
//   - It stages paths, never the tree. `git add -- <files>` with the two files
//     named, and the commit is path-limited too, so work somebody had already
//     staged for a commit of their own stays staged and uncommitted.
//   - It never forces. There is no flag for it, for the reason `worktreePush`
//     has none: the value of a force push is overwriting somebody else's work.
//   - It reports the commit even when the push failed. "Your teammate pushed
//     first" is the ordinary way this goes wrong, and calling the whole thing a
//     failure would leave somebody believing no commit exists.
//
// The fourth thing it does is newer and is why this file has a `signal` and an
// `onOutput` in it. A push is the only part of setting teamwork up that crosses
// a network, and until it reported otherwise the window had exactly two states
// for it: "Pushing…" and, up to ten minutes later, a result. Every way this
// goes slowly looked the same from outside — a big first push, a credential
// nobody can be asked for, a relay of a repository that is simply not there —
// and the only way out was to wait for a timeout that said none of them apart.
// So the push now runs with `--progress` and hands every line of it out as it
// arrives, the whole thing takes an `AbortSignal`, and a run that was stopped
// or that ran out of time comes back as a *result* with the commit in it rather
// than as a throw that loses the half that worked.

import type { PushFailureKind, TeamworkPublish, TeamworkPublishPlan } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitCommandError } from '../git/errors'
import type { GitRunner } from '../git/gitProcess'
import { requireCommitIdentity } from '../git/worktreeCommit'
import { parsePushStatus, pushFailureKind, pushRefusal, type PushRefStatus } from '../git/worktreePush'
import { TeamworkError } from './errors'

/**
 * A push crosses a network, so it gets far longer than a local command.
 *
 * It is still bounded, and the bound is still generous, because the alternative
 * to a timeout is a git process nothing will ever reap holding a panel open for
 * the life of the app. What makes ten minutes tolerable now is that they are no
 * longer silent: the progress is on screen, the wait is counted, and Stop is a
 * button rather than a timeout somebody has to sit out.
 */
const PUSH_TIMEOUT_MS = 10 * 60_000
/** Hooks run on a commit, and a hook can be slow. */
const COMMIT_TIMEOUT_MS = 120_000

/** git's own words, kept whole but never unbounded: a hook can print a novel. */
const MAX_GIT_WORDS = 4_000

/** Which of this call's three git commands is running. */
export type PublishPhase = 'staging' | 'committing' | 'pushing'

export type PublishTarget = {
  projectId: string
  projectPath: string
  /** Paths relative to the project root, as a diff would show them. */
  files: readonly string[]
  message: string
  /** Defaults to `origin`, the only remote most repositories have. */
  remote?: string
  now?: () => number
  /**
   * Aborting kills whichever git is running and ends the call.
   *
   * A cancel during the push is reported rather than thrown, for the same
   * reason a rejection is: the commit may well have landed, and a caller that
   * hears only "cancelled" would go on believing it had not.
   */
  signal?: AbortSignal
  /** Called as each phase begins, so a panel can say which command is running. */
  onPhase?: (phase: PublishPhase) => void
  /** Called with every line git prints while it runs. Progress meters included. */
  onOutput?: (line: string) => void
}

/**
 * What the button would do, in the words it will be described with.
 *
 * Every blocker it can report is a thing the panel has to be able to say in one
 * sentence that names the fix, because the alternative is a button that looks
 * live and then explains itself only after it has been pressed.
 */
export async function readPublishPlan(runner: GitRunner, target: PublishTarget): Promise<TeamworkPublishPlan> {
  const remote = target.remote ?? 'origin'
  const files = [...target.files]
  const now = target.now ?? Date.now
  const branch = await currentBranch(runner, target.projectPath)
  const upstream = branch === null ? null : await upstreamOf(runner, target.projectPath, branch)
  const committed = files.length > 0 && (await nothingOutstanding(runner, target.projectPath, files))

  return {
    projectId: target.projectId,
    files,
    message: target.message,
    remote,
    branch,
    upstream,
    committed,
    blocker: await blockerFor(runner, target, remote, branch),
    readAt: now()
  }
}

/** The first thing that would stop this, in words to act on, or null. */
async function blockerFor(
  runner: GitRunner,
  target: PublishTarget,
  remote: string,
  branch: string | null
): Promise<string | null> {
  if (target.files.length === 0) {
    return 'There is nothing to push yet. Add your key, or set the relay, and this is what sends them.'
  }
  if (branch === null) {
    return 'This checkout is not on a branch, so there is nothing to push. Check one out first: git switch -c main.'
  }
  if (!(await hasRemote(runner, target.projectPath, remote))) {
    return `This checkout has no ${remote} remote, so there is nowhere to push. Add it at the top of this page.`
  }
  const { exitCode } = await runner.tryRun({
    args: ['var', 'GIT_AUTHOR_IDENT'],
    cwd: target.projectPath,
    readOnly: true,
    timeoutMs: 30_000
  })
  if (exitCode !== 0) {
    return (
      'git does not know who you are, so it will not write a commit. Set it once, in a terminal: ' +
      'git config --global user.name "Your Name" and git config --global user.email "you@example.com".'
    )
  }
  return null
}

/**
 * Stages the named files, commits them, and pushes the branch.
 *
 * Refuses before touching anything when the plan says it cannot be done, so the
 * refusal a caller gets is the same sentence the panel was already showing.
 */
export async function publish(runner: GitRunner, target: PublishTarget): Promise<TeamworkPublish> {
  const plan = await readPublishPlan(runner, target)
  if (plan.blocker !== null) throw new TeamworkError(ErrorCode.Conflict, plan.blocker)
  const branch = plan.branch as string
  const { remote } = plan
  const now = target.now ?? Date.now
  const signal = target.signal ? { signal: target.signal } : {}

  await requireCommitIdentity(runner, target.projectPath)

  target.onPhase?.('staging')
  // `--` first, so a path that looks like a flag or a ref is still a path.
  await runner.run({
    args: ['add', '--', ...plan.files],
    cwd: target.projectPath,
    timeoutMs: COMMIT_TIMEOUT_MS,
    ...signal
  })

  // Path-limited, and that is the point: whatever else somebody had staged for
  // a commit of their own is left exactly where it was.
  const outstanding = await runner.run({
    args: ['diff', '--cached', '--name-only', '--', ...plan.files],
    cwd: target.projectPath,
    readOnly: true,
    timeoutMs: 30_000,
    ...signal
  })

  let commit: TeamworkPublish['commit'] = null
  if (outstanding.stdout.trim() !== '') {
    target.onPhase?.('committing')
    const committed = await runner.tryRun({
      args: ['commit', '-m', target.message, '--', ...plan.files],
      cwd: target.projectPath,
      timeoutMs: COMMIT_TIMEOUT_MS,
      ...signal
    })
    if (committed.exitCode !== 0) {
      throw new TeamworkError(ErrorCode.GitFailed, clip(committed.stderr) || 'git refused to make the commit')
    }
    const { stdout } = await runner.run({
      args: ['rev-parse', 'HEAD'],
      cwd: target.projectPath,
      readOnly: true,
      timeoutMs: 30_000
    })
    const sha = stdout.trim()
    commit = { sha, shortSha: sha.slice(0, 7), message: target.message }
  }

  target.onPhase?.('pushing')
  return {
    projectId: target.projectId,
    files: plan.files,
    commit,
    remote,
    branch,
    push: await pushOnce(runner, target, plan, branch, remote),
    at: now()
  }
}

/** The push itself, and every way it can end, as one verdict the caller reports. */
async function pushOnce(
  runner: GitRunner,
  target: PublishTarget,
  plan: TeamworkPublishPlan,
  branch: string,
  remote: string
): Promise<TeamworkPublish['push']> {
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`
  const signal = target.signal ? { signal: target.signal } : {}

  let pushed
  try {
    pushed = await runner.tryRun({
      // `--progress` because git draws its meter only when it believes
      // something is watching, and a pipe is not a terminal. Without it the
      // slowest part of this whole flow prints one line at the end, which is
      // the difference between a panel that can say "writing objects, 60%" and
      // one that can only say "Pushing…".
      args: [
        'push',
        '--progress',
        '--porcelain',
        ...(plan.upstream === null ? ['--set-upstream'] : []),
        remote,
        refspec
      ],
      cwd: target.projectPath,
      timeoutMs: PUSH_TIMEOUT_MS,
      env: { GIT_SSH_COMMAND: await sshCommand(runner, target.projectPath) },
      onStderr: (chunk) => {
        for (const line of splitProgress(chunk)) target.onOutput?.(line)
      },
      ...signal
    })
  } catch (error) {
    // A push that was stopped or that ran out of time is still a publish with
    // a commit in it, so it comes back as a verdict rather than as a throw.
    // `tryRun` rejects for exactly these two and for a git that would not start
    // at all; the last of those is nobody's remedy but an installation's, and
    // it keeps git's own sentence.
    if (!(error instanceof GitCommandError)) throw error
    if (error.cancelled) {
      return {
        ok: false,
        kind: 'cancelled',
        error: clip(error.stderr) || 'the push was stopped before it finished',
        advice:
          'You stopped this push, so nothing reached ' +
          `${remote}. The commit is still here; pressing the button again sends it.`
      }
    }
    if (error.timedOut) {
      return {
        ok: false,
        kind: 'timeout',
        error: clip(error.stderr) || `git push produced nothing for ${Math.round(PUSH_TIMEOUT_MS / 60_000)} minutes`,
        advice:
          `git never finished talking to ${remote}. That is usually a credential this app cannot be asked for, or ` +
          'a host that is not answering; running the same push once in Terminal says which.'
      }
    }
    throw error
  }

  const reported = parsePushStatus(pushed.stdout, refspec)
  if (pushed.exitCode === 0) {
    return {
      ok: true,
      upstream: (await upstreamOf(runner, target.projectPath, branch)) ?? `${remote}/${branch}`,
      setUpstream: plan.upstream === null,
      alreadyUpToDate: reported?.flag === '='
    }
  }
  return {
    // git's own words, whole. The panel prints them as git printed them,
    // because the one thing a refused push must not be is paraphrased into
    // something nobody can search for.
    ok: false,
    kind: kindOf(pushed.stderr, pushed.exitCode, reported),
    error: clip(pushed.stderr) || clip(pushed.stdout) || `git exited ${pushed.exitCode}`,
    advice: pushRefusal(pushed.stderr, remote, branch, reported)
  }
}

/** git's verdict, with the one case git never prints anything for. */
function kindOf(stderr: string, exitCode: number, reported: PushRefStatus | null): PushFailureKind {
  const said = pushFailureKind(stderr, reported)
  if (said !== 'other') return said
  // A git killed by a signal exits negative or above 128 and says nothing at
  // all, which reads as "it refused" when it in fact never answered.
  return exitCode < 0 || exitCode > 128 ? 'timeout' : 'other'
}

/**
 * The ssh this push is allowed to use, which is the caller's own with one thing
 * added: it may not stop and ask this machine's user anything.
 *
 * This is the bug the report was about. `GIT_TERMINAL_PROMPT=0` stops *git*
 * prompting, and does nothing whatever to ssh — which is a separate program
 * that opens `/dev/tty` directly for a key passphrase or for a host key it has
 * never seen. Started from a terminal, as teamree in development is, that tty
 * exists and is behind the app's own window, so the push waits on a question
 * nobody can see for as long as the timeout allows. `BatchMode=yes` turns that
 * wait into an immediate refusal with a sentence in it, which is the whole
 * difference between a hang and an error message.
 *
 * It is built on top of whatever ssh the user already asked for rather than
 * replacing it: `GIT_SSH_COMMAND` outranks `core.sshCommand`, so a team that
 * sets one in their config would otherwise find teamree quietly pushing with a
 * different key than every other tool on the machine.
 */
async function sshCommand(runner: GitRunner, cwd: string): Promise<string> {
  const configured = await runner.tryRun({
    args: ['config', '--get', 'core.sshCommand'],
    cwd,
    readOnly: true,
    timeoutMs: 30_000
  })
  const base =
    process.env.GIT_SSH_COMMAND?.trim() || (configured.exitCode === 0 ? configured.stdout.trim() : '') || 'ssh'
  return `${base} -o BatchMode=yes`
}

/**
 * git's progress, as lines.
 *
 * A meter redraws itself with a carriage return rather than a newline, so a
 * chunk of it is one line as far as anything counting `\n` is concerned and
 * forty as far as a reader is. Both separators split here, and empties go, so
 * what a panel shows is the last thing git actually said rather than a
 * kilobyte of the same sentence at different percentages.
 */
export function splitProgress(chunk: string): string[] {
  return chunk
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The branch this checkout has out, or null when HEAD is detached. */
async function currentBranch(runner: GitRunner, cwd: string): Promise<string | null> {
  const { exitCode, stdout } = await runner.tryRun({
    args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    cwd,
    readOnly: true,
    timeoutMs: 30_000
  })
  const name = stdout.trim()
  return exitCode === 0 && name.length > 0 ? name : null
}

/** What the branch already tracks, or null when it tracks nothing. */
async function upstreamOf(runner: GitRunner, cwd: string, branch: string): Promise<string | null> {
  const { exitCode, stdout } = await runner.tryRun({
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
    cwd,
    readOnly: true,
    timeoutMs: 30_000
  })
  const name = stdout.trim()
  return exitCode === 0 && name.length > 0 ? name : null
}

async function hasRemote(runner: GitRunner, cwd: string, remote: string): Promise<boolean> {
  const { exitCode } = await runner.tryRun({
    args: ['remote', 'get-url', remote],
    cwd,
    readOnly: true,
    timeoutMs: 30_000
  })
  return exitCode === 0
}

/** True when git reports no change at all for these paths — so they are committed. */
async function nothingOutstanding(runner: GitRunner, cwd: string, files: readonly string[]): Promise<boolean> {
  const { exitCode, stdout } = await runner.tryRun({
    args: ['status', '--porcelain', '--untracked-files=normal', '--', ...files],
    cwd,
    readOnly: true,
    timeoutMs: 30_000
  })
  return exitCode === 0 && stdout.trim() === ''
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_GIT_WORDS ? trimmed : `${trimmed.slice(0, MAX_GIT_WORDS)}…`
}
