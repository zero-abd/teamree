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

import type { TeamworkPublish, TeamworkPublishPlan } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import type { GitRunner } from '../git/gitProcess'
import { requireCommitIdentity } from '../git/worktreeCommit'
import { parsePushStatus, pushRefusal } from '../git/worktreePush'
import { TeamworkError } from './errors'

/** A push crosses a network, so it gets far longer than a local command. */
const PUSH_TIMEOUT_MS = 10 * 60_000
/** Hooks run on a commit, and a hook can be slow. */
const COMMIT_TIMEOUT_MS = 120_000

/** git's own words, kept whole but never unbounded: a hook can print a novel. */
const MAX_GIT_WORDS = 4_000

export type PublishTarget = {
  projectId: string
  projectPath: string
  /** Paths relative to the project root, as a diff would show them. */
  files: readonly string[]
  message: string
  /** Defaults to `origin`, the only remote most repositories have. */
  remote?: string
  now?: () => number
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

  await requireCommitIdentity(runner, target.projectPath)

  // `--` first, so a path that looks like a flag or a ref is still a path.
  await runner.run({
    args: ['add', '--', ...plan.files],
    cwd: target.projectPath,
    timeoutMs: COMMIT_TIMEOUT_MS
  })

  // Path-limited, and that is the point: whatever else somebody had staged for
  // a commit of their own is left exactly where it was.
  const outstanding = await runner.run({
    args: ['diff', '--cached', '--name-only', '--', ...plan.files],
    cwd: target.projectPath,
    readOnly: true,
    timeoutMs: 30_000
  })

  let commit: TeamworkPublish['commit'] = null
  if (outstanding.stdout.trim() !== '') {
    const committed = await runner.tryRun({
      args: ['commit', '-m', target.message, '--', ...plan.files],
      cwd: target.projectPath,
      timeoutMs: COMMIT_TIMEOUT_MS
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

  const refspec = `refs/heads/${branch}:refs/heads/${branch}`
  const pushed = await runner.tryRun({
    args: ['push', '--porcelain', ...(plan.upstream === null ? ['--set-upstream'] : []), remote, refspec],
    cwd: target.projectPath,
    timeoutMs: PUSH_TIMEOUT_MS
  })
  const reported = parsePushStatus(pushed.stdout, refspec)

  return {
    projectId: target.projectId,
    files: plan.files,
    commit,
    remote,
    branch,
    push:
      pushed.exitCode === 0
        ? {
            ok: true,
            upstream: (await upstreamOf(runner, target.projectPath, branch)) ?? `${remote}/${branch}`,
            setUpstream: plan.upstream === null,
            alreadyUpToDate: reported?.flag === '='
          }
        : {
            // git's own words, whole. The panel prints them as git printed
            // them, because the one thing a refused push must not be is
            // paraphrased into something nobody can search for.
            ok: false,
            error: clip(pushed.stderr) || clip(pushed.stdout) || `git exited ${pushed.exitCode}`,
            advice: pushRefusal(pushed.stderr, remote, branch, reported)
          },
    at: now()
  }
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
