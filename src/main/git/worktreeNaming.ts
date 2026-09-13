// Turning a human task name into a branch and a directory.
//
// Both have to be collision-free, because the whole product is several agents
// working at once: two people naming a task "fix login" must not race for the
// same branch or the same checkout on disk.

import { access } from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { describeError, GitServiceError } from './errors'
import { pathKey } from './pathIdentity'
import { slugifyBranchName } from '../../shared/branchName'

/**
 * The slug rule lives in shared so the create dialog previews exactly what gets
 * created. Re-exported here because this module is where callers expect it.
 */
export const slugify = slugifyBranchName

/**
 * Windows refuses to create a file or directory whose name is a DOS device,
 * whatever the extension. That kills both halves of a worktree at once: the
 * checkout directory, and git's own loose ref file under refs/heads. Names are
 * therefore disambiguated at the source rather than at each use.
 *
 * The list itself is in shared, because member filenames obey it too and the
 * window now reads that rule. Re-exported here because this module is where
 * callers expect it.
 */
export { isWindowsDeviceName } from '../../shared/windowsNames'

/**
 * Lowercase ASCII words joined by dashes. This deliberately throws away more
 * than git forbids: a branch that survives being typed into a shell prompt,
 * pasted into a PR, and used as a folder name on Windows is worth more than one
 * that faithfully preserves the task title.
 */

/**
 * git stores branches as files, so `feature` and `feature/login` cannot both
 * exist. A candidate collides if it equals, contains, or is contained by a
 * taken name. Comparison is case-insensitive because loose refs live on
 * case-insensitive filesystems on macOS and Windows.
 */
export function branchCollides(candidate: string, taken: ReadonlySet<string>): boolean {
  const lower = candidate.toLowerCase()
  if (taken.has(lower)) return true
  for (const name of taken) {
    if (name.startsWith(`${lower}/`) || lower.startsWith(`${name}/`)) return true
  }
  return false
}

export function allocateBranchName(taskName: string, existingBranches: readonly string[]): string {
  const taken = new Set(existingBranches.map((branch) => branch.toLowerCase()))
  const base = slugify(taskName)
  if (!branchCollides(base, taken)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!branchCollides(candidate, taken)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** Branches may contain `/`; directories should stay one level deep. */
export function checkoutDirName(branch: string): string {
  return slugify(branch.replace(/\//g, '-'))
}

export function projectDirName(projectName: string): string {
  return slugify(projectName)
}

/**
 * `<root>/<project>/<branch>`, deduped against whatever is already on disk so a
 * leftover directory from a crashed create can never be checked out into.
 */
export async function allocateCheckoutPath(
  worktreesRoot: string,
  projectName: string,
  branch: string,
  /** pathKey values of checkouts already handed out but not yet on disk. */
  claimed: ReadonlySet<string> = new Set()
): Promise<string> {
  const parent = path.join(worktreesRoot, projectDirName(projectName))
  const base = checkoutDirName(branch)
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = path.join(parent, suffix === 1 ? base : `${base}-${suffix}`)
    if (!claimed.has(pathKey(candidate)) && !(await exists(candidate))) return candidate
  }
  return path.join(parent, `${base}-${Date.now().toString(36)}`)
}

/**
 * Only "there is nothing there" makes a path free.
 *
 * Any other answer is "could not tell", and could-not-tell must not become
 * was-not-there here of all places: the path this returns is handed to
 * `git worktree add`, and a create that fails then deletes the directory it
 * was pointed at. A permission error, an I/O error or a symlink loop all mean
 * something may well be sitting there, so they are raised rather than guessed
 * past.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new GitServiceError(ErrorCode.Conflict, `cannot tell whether ${target} is free: ${describeError(error)}`)
  }
}
