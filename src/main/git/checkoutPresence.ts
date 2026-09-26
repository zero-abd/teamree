// Whether a linked checkout is still on disk where its record says, read from the files git keeps
// rather than by running git, so a listing can ask it of every worktree.

import { lstat, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { canonicalPath, pathKey } from './pathIdentity'

/** `gone`: no folder. `foreign`: a folder that is not this checkout any more (emptied, re-cloned, or a copy). */
export type CheckoutPresence = 'present' | 'gone' | 'foreign'

export async function checkoutPresence(root: string): Promise<CheckoutPresence> {
  if (!(await isDirectory(root))) return 'gone'
  const linked = await linkedCheckout(root)
  if (linked === undefined) return 'foreign'
  // Git's own back-pointer: a moved or copied folder still names the admin directory, which names the old place.
  const back = await readLine(path.join(linked.adminDir, 'gitdir'))
  if (back === undefined) return 'foreign'
  return pathKey(path.resolve(linked.adminDir, back)) === pathKey(path.join(root, '.git')) ? 'present' : 'foreign'
}

/** The admin directory a linked checkout's `.git` file names, and its repository's common git directory. */
export async function linkedCheckout(root: string): Promise<{ adminDir: string; commonDir: string } | undefined> {
  const dotGit = path.join(root, '.git')
  const info = await lstat(dotGit).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  const named = (await readLine(dotGit))?.match(/^gitdir:\s*(.+)$/)?.[1]
  if (named === undefined) return undefined
  const adminDir = path.resolve(root, named)
  const common = await readLine(path.join(adminDir, 'commondir'))
  if (common === undefined) return undefined
  return { adminDir, commonDir: canonicalPath(path.resolve(adminDir, common)) }
}

/** A repository's common git directory: its own `.git`, or the one a linked checkout's names. */
export async function commonGitDir(repoRoot: string): Promise<string | undefined> {
  const dotGit = path.join(repoRoot, '.git')
  if (await isDirectory(dotGit)) return canonicalPath(dotGit)
  return (await linkedCheckout(repoRoot))?.commonDir
}

/**
 * Deletes git's record of a linked checkout at `root` (its admin directory), as `git worktree prune` would for
 * that one entry; nothing at `root` is touched. For a checkout that is gone or foreign, where git refuses to.
 */
export async function dropRegistration(repoRoot: string, root: string): Promise<boolean> {
  const common = await commonGitDir(repoRoot)
  if (common === undefined) return false
  const admins = path.join(common, 'worktrees')
  const names = await readdir(admins).catch(() => [])
  const here = pathKey(path.join(root, '.git'))
  for (const name of names) {
    const adminDir = path.join(admins, name)
    const back = await readLine(path.join(adminDir, 'gitdir'))
    if (back === undefined || pathKey(path.resolve(adminDir, back)) !== here) continue
    await rm(adminDir, { recursive: true, force: true })
    return true
  }
  return false
}

async function readLine(file: string): Promise<string | undefined> {
  try {
    const line = (await readFile(file, 'utf8')).split(/\r?\n/)[0]?.trim()
    return line === undefined || line === '' ? undefined : line
  } catch {
    return undefined
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}
