// Reading facts out of a repository: is it one, what is it called, and what
// should new work branch from by default. Interpreting a start point a caller
// chose instead of that default is startPoint.ts's job.

import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'

export type RepositoryInfo = {
  /** Work-tree root, or the git dir for a bare repo. */
  root: string
  bare: boolean
  /** Folder-derived name, before any user-supplied override. */
  defaultName: string
}

/** Refs beginning with `-` would be read by git as options. */
export function assertRefShape(ref: string, label: string): void {
  if (!ref || ref.startsWith('-') || ref.includes('..') || /\s/.test(ref)) {
    throw new GitServiceError(ErrorCode.InvalidParams, `${label} "${ref}" is not a usable git ref`)
  }
}

export async function inspectRepository(runner: GitRunner, directory: string): Promise<RepositoryInfo> {
  if (!path.isAbsolute(directory)) {
    throw new GitServiceError(ErrorCode.InvalidParams, `project path must be absolute, got "${directory}"`)
  }

  const probe = await runner.tryRun({ args: ['rev-parse', '--is-bare-repository'], cwd: directory, readOnly: true })
  if (probe.exitCode !== 0) {
    const reason = probe.stderr.trim()
    throw new GitServiceError(
      ErrorCode.InvalidParams,
      `"${directory}" is not a git repository${reason ? `: ${reason}` : ''}`
    )
  }

  const bare = probe.stdout.trim() === 'true'
  const { stdout } = await runner.run({
    args: ['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'],
    cwd: directory,
    readOnly: true
  })
  const root = stdout.trim()
  if (!root) {
    throw new GitServiceError(ErrorCode.InvalidParams, `could not locate the repository root for "${directory}"`)
  }

  return { root, bare, defaultName: repositoryName(root) }
}

function repositoryName(root: string): string {
  const base = path.basename(root)
  const withoutGitSuffix = base.endsWith('.git') ? base.slice(0, -'.git'.length) : base
  return withoutGitSuffix || base || 'repository'
}

/**
 * The one base ref that cannot be compared against: inside a worktree `HEAD`
 * *is* the branch, and the comparison exits 0 with zero commits.
 */
const SELF_REFERENTIAL_BASE = 'HEAD'

/** Whether `base..branch` means anything at all for this base. */
export function comparesAgainstItself(baseRef: string): boolean {
  return baseRef.trim() === SELF_REFERENTIAL_BASE
}

/**
 * What new worktrees branch from. origin/HEAD is the repository's own answer to
 * "what is the trunk", so it wins; the rest is a fallback chain for clones that
 * never ran `git remote set-head` and for repos with no remote at all.
 */
export async function detectBaseRef(runner: GitRunner, root: string): Promise<string> {
  const originHead = await runner.tryRun({
    args: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    cwd: root,
    readOnly: true
  })
  if (originHead.exitCode === 0 && originHead.stdout.trim()) return originHead.stdout.trim()

  for (const candidate of ['origin/main', 'origin/master']) {
    if (await refExists(runner, root, `refs/remotes/${candidate}`)) return candidate
  }

  const head = await runner.tryRun({ args: ['symbolic-ref', '--short', 'HEAD'], cwd: root, readOnly: true })
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim()

  // A detached HEAD has no branch name, and the literal "HEAD" would be read
  // inside each worktree as its own branch; the parked commit is a stable base.
  const detached = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    cwd: root,
    readOnly: true
  })
  if (detached.exitCode === 0 && detached.stdout.trim()) return detached.stdout.trim()

  // Nothing is committed yet; every reader of a base ref refuses this one.
  return SELF_REFERENTIAL_BASE
}

export async function refExists(runner: GitRunner, root: string, ref: string): Promise<boolean> {
  const result = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    cwd: root,
    readOnly: true
  })
  return result.exitCode === 0
}

/** Local branch short names, e.g. `main`, `feature/login`. */
export async function listBranchNames(runner: GitRunner, root: string): Promise<string[]> {
  const { stdout } = await runner.run({
    args: ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    cwd: root,
    readOnly: true
  })
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
