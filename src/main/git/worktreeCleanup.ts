// Clean Up Merged: which landed worktrees go, and in what order. A squash or rebase merge leaves no
// ancestry, so such a branch never reads as landed and is left to a one-at-a-time delete.

import type { Worktree } from '../../shared/entities'
import { descendantsOf } from '../../shared/taskTree'
import type { GitRunner } from './gitProcess'
import { hasLanded } from './worktreeNest'
import { bareRef } from './reviewUrl'

/** What the git reads said about one worktree: landed or not, and why it must stay if it must. */
export type CleanupRead = { landed: boolean; hold?: string; ignored?: number }

export type CleanupPlan = {
  removed: { worktree: Worktree; ignored?: number }[]
  kept: { worktree: Worktree; reason: string }[]
}

/**
 * A landed worktree goes when it is free to and was chosen (all of them without `chosen`),
 * and only with every child it has; children come before their parents.
 */
export function planCleanup(
  worktrees: readonly Worktree[],
  reads: ReadonlyMap<string, CleanupRead>,
  chosen?: ReadonlySet<string>
): CleanupPlan {
  const free = (worktree: Worktree): boolean => {
    const read = reads.get(worktree.id)
    return read?.landed === true && read.hold === undefined && (chosen === undefined || chosen.has(worktree.id))
  }
  const plan: CleanupPlan = { removed: [], kept: [] }
  for (const worktree of worktrees) {
    const read = reads.get(worktree.id)
    if (read?.landed !== true || (chosen !== undefined && !chosen.has(worktree.id))) continue
    if (read.hold !== undefined) {
      plan.kept.push({ worktree, reason: read.hold })
      continue
    }
    const staying = descendantsOf(worktrees, worktree.id).filter((child) => !free(child)).length
    if (staying > 0) {
      plan.kept.push({ worktree, reason: `${staying} ${staying === 1 ? 'child stays' : 'children stay'}` })
      continue
    }
    plan.removed.push({ worktree, ...(read.ignored ? { ignored: read.ignored } : {}) })
  }
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const depth = (worktree: Worktree): number => {
    let found = 0
    for (let up = worktree.parentId; up !== undefined && found < worktrees.length; up = byId.get(up)?.parentId) found++
    return found
  }
  plan.removed.sort((a, b) => depth(b.worktree) - depth(a.worktree))
  return plan
}

/** Made a commit, and every commit it made is in its base or in the local branch of that name. */
export async function landedInBase(
  runner: GitRunner,
  repoPath: string,
  worktree: Worktree,
  base: string
): Promise<boolean> {
  const repo = { runner, cwd: repoPath }
  if (await hasLanded(repo, worktree.branch, worktree.startedFrom, base)) return true
  const local = `refs/heads/${bareRef(base, 'origin')}`
  if (local === `refs/heads/${base}` || local === base) return false
  const exists = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', local],
    cwd: repoPath,
    readOnly: true
  })
  return exists.exitCode === 0 && hasLanded(repo, worktree.branch, worktree.startedFrom, local)
}
