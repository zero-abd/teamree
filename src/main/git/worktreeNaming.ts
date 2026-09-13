// Turning a human task name into a branch and a directory.
//
// Both have to be collision-free, because the whole product is several agents
// working at once: two people naming a task "fix login" must not race for the
// same branch or the same checkout on disk.

import { access } from 'node:fs/promises'
import path from 'node:path'
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
 */
const WINDOWS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 10 }, (_, index) => `com${index}`),
  ...Array.from({ length: 10 }, (_, index) => `lpt${index}`)
])

export function isWindowsDeviceName(name: string): boolean {
  return WINDOWS_DEVICE_NAMES.has(name.toLowerCase())
}

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

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}
