// Reading facts out of a repository: is it one, what is it called, and what
// should new work branch from by default. Interpreting a start point a caller
// chose instead of that default is startPoint.ts's job.

import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { canonicalPath } from './pathIdentity'

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

  return { root: canonicalPath(root), bare, defaultName: repositoryName(root) }
}

function repositoryName(root: string): string {
  const base = path.basename(root)
  const withoutGitSuffix = base.endsWith('.git') ? base.slice(0, -'.git'.length) : base
  return withoutGitSuffix || base || 'repository'
}

/**
 * The one base ref that cannot be compared against.
 *
 * Every `base..branch` read runs inside the worktree, where `HEAD` *is* that
 * branch. The comparison becomes the branch against itself, which exits 0 and
 * answers zero commits and zero ahead however much work is there — the worst
 * shape a wrong answer can take, because nothing about it looks like a failure.
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

  // A primary checkout on a detached HEAD — bisecting, or sitting on a tag —
  // has no branch name to offer, and the literal "HEAD" would be read inside
  // each worktree as that worktree's own branch. The commit it is parked on is
  // a real, stable base that says the same thing without the trap; a worktree
  // already records its start point as "a ref name or a commit sha".
  const detached = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    cwd: root,
    readOnly: true
  })
  if (detached.exitCode === 0 && detached.stdout.trim()) return detached.stdout.trim()

  // Nothing is committed yet, so there is genuinely nothing to branch from.
  // Every reader of a base ref refuses this one rather than comparing with it.
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
