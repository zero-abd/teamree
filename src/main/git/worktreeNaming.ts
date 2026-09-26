// Turning a human task name into a branch and a directory, both collision-free:
// two people naming a task "fix login" must not race for the same checkout.

import { access } from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { describeError, GitServiceError } from './errors'
import { pathKey } from './pathIdentity'
import { slugifyBranchName, taskNamesForAgents } from '../../shared/branchName'

/** The slug rule lives in shared so the create dialog previews exactly what gets created. */
export const slugify = slugifyBranchName

/**
 * One task, several agents: the rule that keeps their names apart. The names
 * still go through `allocateBranchName`, so the suffix is not a second collision rule.
 */
export { taskNamesForAgents }

/**
 * Windows refuses a file or directory named after a DOS device, whatever the
 * extension, which kills both the checkout and git's loose ref under refs/heads.
 */
export { isWindowsDeviceName } from '../../shared/windowsNames'

/**
 * git stores branches as files, so `feature` and `feature/login` cannot both
 * exist. Case-insensitive because loose refs live on case-insensitive filesystems.
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

/** `<parent-branch>--<slug>`: `--` because `a/b` cannot coexist with `a`. Deduped as `allocateBranchName` does. */
export function allocateChildBranchName(parentBranch: string, taskName: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((branch) => branch.toLowerCase()))
  const base = `${parentBranch}--${slugify(taskName)}`
  if (!branchCollides(base, taken)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!branchCollides(candidate, taken)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** `<parent-dir>--<tail>`, the tail being what the child's branch adds to its parent's. */
export function childCheckoutDirName(parentPath: string, parentBranch: string, childBranch: string): string {
  const prefix = `${parentBranch}--`
  const tail = childBranch.startsWith(prefix) ? childBranch.slice(prefix.length) : childBranch
  return `${path.basename(parentPath)}--${checkoutDirName(tail)}`
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
  claimed: ReadonlySet<string> = new Set(),
  /** The directory name to dedupe from, when not the branch's own. */
  dirName: string = checkoutDirName(branch)
): Promise<string> {
  const parent = path.join(worktreesRoot, projectDirName(projectName))
  const base = dirName
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = path.join(parent, suffix === 1 ? base : `${base}-${suffix}`)
    if (!claimed.has(pathKey(candidate)) && !(await exists(candidate))) return candidate
  }
  return path.join(parent, `${base}-${Date.now().toString(36)}`)
}

/**
 * Only "there is nothing there" makes a path free: a create that fails deletes
 * the directory it was pointed at, so could-not-tell is raised, not guessed past.
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
