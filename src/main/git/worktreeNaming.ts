// Turning a human task name into a branch and a directory, both collision-free:
// two people naming a task "fix login" must not race for the same checkout.

import { access } from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { describeError, GitServiceError } from './errors'
import { pathKey } from './pathIdentity'
import { slugifyBranchName, taskNamesForAgents } from '../../shared/branchName'

export { allocateBranchName, branchCollides } from '../../shared/branchName'

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
