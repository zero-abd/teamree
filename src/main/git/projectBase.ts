// The project checkout's base branch against origin: how far a local landing is ahead, pushing it, and
// pulling origin's when a push is refused because origin moved.

import type { ProjectBase, PushFailureKind } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { assertRefShape } from './repository'
import { bareRef } from './reviewUrl'
import { pushWorktree } from './worktreePush'

const REMOTE = 'origin'

export type ProjectBaseOptions = { projectId: string; repoPath: string; baseRef: string }

export async function readProjectBase(runner: GitRunner, options: ProjectBaseOptions): Promise<ProjectBase> {
  const branch = baseBranch(options.baseRef)
  // One process: the upstream and git's own ahead/behind for it.
  const read = await runner.tryRun({
    args: ['for-each-ref', '--format=%(upstream:short)%00%(upstream:track,nobracket)', `refs/heads/${branch}`],
    cwd: options.repoPath,
    readOnly: true,
    timeoutMs: 30_000
  })
  const [upstream = '', track = ''] = (read.exitCode === 0 ? read.stdout.trim() : '').split('\0')
  const count = (word: string): number => Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0)
  return {
    projectId: options.projectId,
    branch,
    ...(upstream === '' || track === 'gone' ? {} : { upstream }),
    ahead: count('ahead'),
    behind: count('behind')
  }
}

/** Pushes the base through the worktree push path; a refusal because origin moved says so in those words. */
export async function pushProjectBase(runner: GitRunner, options: ProjectBaseOptions): Promise<ProjectBase> {
  const branch = baseBranch(options.baseRef)
  try {
    await pushWorktree(runner, { worktreeId: options.projectId, worktreePath: options.repoPath, branch })
  } catch (error) {
    if (!(error instanceof GitServiceError)) throw error
    const data = error.data as { detail?: string; kind?: PushFailureKind } | undefined
    if (data?.kind !== 'rejected') throw error
    throw new GitServiceError(error.code, `${REMOTE}/${branch} moved`, data)
  }
  return readProjectBase(runner, options)
}

/** Fetches origin's base and merges it into the checkout's, never leaving the checkout mid-merge. */
export async function pullProjectBase(runner: GitRunner, options: ProjectBaseOptions): Promise<ProjectBase> {
  const branch = baseBranch(options.baseRef)
  const cwd = options.repoPath
  await requireCheckedOut(runner, cwd, branch)
  const tracking = `refs/remotes/${REMOTE}/${branch}`
  const fetched = await runner.tryRun({
    args: ['fetch', '--no-tags', REMOTE, `+refs/heads/${branch}:${tracking}`],
    cwd,
    timeoutMs: 10 * 60_000
  })
  if (fetched.exitCode !== 0) {
    throw new GitServiceError(ErrorCode.GitFailed, firstLine(fetched.stderr) || `could not fetch ${REMOTE}/${branch}`, {
      detail: fetched.stderr.trim()
    })
  }
  const merged = await runner.tryRun({ args: ['merge', '--no-edit', tracking], cwd, timeoutMs: 120_000 })
  if (merged.exitCode !== 0) {
    const unmerged = await runner.tryRun({ args: ['diff', '--name-only', '--diff-filter=U'], cwd, readOnly: true })
    const conflicts = unmerged.stdout.split('\n').filter(Boolean)
    if (conflicts.length > 0) await runner.tryRun({ args: ['merge', '--abort'], cwd }).catch(() => undefined)
    throw new GitServiceError(
      ErrorCode.Conflict,
      conflicts.length > 0
        ? `${REMOTE}/${branch} conflicts with ${branch} in ${conflicts.join(', ')}`
        : firstLine(merged.stderr) || `could not merge ${REMOTE}/${branch}`,
      conflicts.length > 0 ? { conflicts } : { detail: merged.stderr.trim() }
    )
  }
  return readProjectBase(runner, options)
}

/** Puts the checkout's base back at origin's, undoing local landings; refused when a commit only it holds would go. */
export async function resetProjectBase(runner: GitRunner, options: ProjectBaseOptions): Promise<ProjectBase> {
  const branch = baseBranch(options.baseRef)
  const cwd = options.repoPath
  await requireCheckedOut(runner, cwd, branch)
  const tracking = `refs/remotes/${REMOTE}/${branch}`
  // Merge commits are the landings themselves; every other commit must still be on some other branch.
  const only = await runner.tryRun({
    args: [
      'rev-list',
      '--count',
      '--no-merges',
      `refs/heads/${branch}`,
      '--not',
      tracking,
      `--exclude=${branch}`,
      '--branches'
    ],
    cwd,
    readOnly: true
  })
  if (only.exitCode !== 0) {
    throw new GitServiceError(ErrorCode.GitFailed, firstLine(only.stderr) || `could not read ${branch}`)
  }
  const count = Number.parseInt(only.stdout.trim(), 10) || 0
  if (count > 0) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      `${count} ${count === 1 ? 'commit is' : 'commits are'} only on ${branch}`
    )
  }
  const reset = await runner.tryRun({ args: ['reset', '--keep', tracking], cwd, timeoutMs: 120_000 })
  if (reset.exitCode !== 0) {
    throw new GitServiceError(ErrorCode.Conflict, firstLine(reset.stderr) || `could not reset ${branch}`, {
      detail: reset.stderr.trim()
    })
  }
  return readProjectBase(runner, options)
}

async function requireCheckedOut(runner: GitRunner, cwd: string, branch: string): Promise<void> {
  const head = await runner.tryRun({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, readOnly: true })
  const current = head.exitCode === 0 ? head.stdout.trim() : ''
  if (current !== branch) {
    throw new GitServiceError(
      ErrorCode.Conflict,
      `${cwd} has ${current === '' ? 'a detached HEAD' : current} checked out, not ${branch}`
    )
  }
}

function baseBranch(baseRef: string): string {
  const branch = bareRef(baseRef, REMOTE)
  assertRefShape(branch, 'base branch')
  return branch
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}
