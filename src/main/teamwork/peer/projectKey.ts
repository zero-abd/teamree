// What makes two checkouts on two machines the same project: the `origin` remote, normalised as
// `@shared/origin` argues, then hashed rather than sent — a presence message naming remotes in the clear
// would tell a teammate the URLs of repositories they are not a member of. No `origin`: does not take part.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitRunner } from '../../git/gitProcess'
import { checkOrigin } from '../../../shared/origin'

/** Domain separation, so this hash can never be mistaken for another one. */
const KEY_PREFIX = 'teamree/project/v1\n'

export type ProjectKeyResult =
  /** `url` is the origin as it is to be named: git's own spelling of a URL, the normalised spelling of a path. */
  | { ok: true; key: string; url: string }
  /** Why this project cannot be matched to a teammate's, for the user to read. */
  | { ok: false; reason: string }

/**
 * The remote's identity, spelled one way. The rule is in `@shared/origin` because the panel that offers
 * to add an origin has to refuse exactly what this would refuse.
 */
export { normaliseRemote } from '../../../shared/origin'

export function projectKeyFor(normalisedRemote: string): string {
  return createHash('sha256').update(KEY_PREFIX).update(normalisedRemote, 'utf8').digest('hex')
}

/** Reads `origin` out of a checkout and turns it into the key, or says why not. */
export async function readProjectKey(runner: GitRunner, projectPath: string): Promise<ProjectKeyResult> {
  let remote: string
  try {
    const { exitCode, stdout } = await runner.tryRun({
      args: ['remote', 'get-url', 'origin'],
      cwd: projectPath,
      readOnly: true
    })
    if (exitCode !== 0) return { ok: false, reason: 'no origin remote' }
    remote = stdout.trim()
  } catch (error) {
    return { ok: false, reason: `git could not be asked for the origin remote: ${messageOf(error)}` }
  }

  const checked = checkOrigin(remote)
  if (!checked.ok) {
    // Names the origin git has: nobody typed this remote, so the reason must say which one it means.
    return { ok: false, reason: `origin ${remote}: ${checked.reason}` }
  }
  // The normalised spelling for a path, git's own for a URL: an invitation wants the characters being hashed.
  return { ok: true, key: projectKeyFor(checked.normalised), url: checked.remote }
}

/**
 * A stamp of the file `origin` is configured in, or `undefined` with no repository to read. `readProjectKey`
 * costs a git subprocess; this costs a `stat`, and changes exactly when asking git again could say something new.
 */
export function originMark(projectPath: string): string | undefined {
  const path = gitConfigPath(projectPath)
  if (path === undefined) return undefined
  try {
    const stats = statSync(path)
    // The inode as well as the clock: git rewrites its config by renaming a lock file over it, so a
    // coarse mtime would otherwise hide a `git remote add` made immediately after a read.
    return `${path}\u0000${stats.ino}\u0000${stats.mtimeMs}\u0000${stats.size}`
  } catch {
    return undefined
  }
}

/**
 * Where git keeps the remotes for a checkout. A linked worktree's `.git` is a file pointing at a directory
 * that borrows the repository's config, so the answer is never simply `<checkout>/.git/config`.
 */
function gitConfigPath(projectPath: string): string | undefined {
  const dotGit = join(projectPath, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'config')
    const pointer = /^gitdir:\s*(.+)$/.exec(readFileSync(dotGit, 'utf8').trim())?.[1]?.trim()
    if (pointer === undefined) return undefined
    const gitDir = isAbsolute(pointer) ? pointer : resolve(projectPath, pointer)
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
      return join(resolve(gitDir, common), 'config')
    } catch {
      return join(gitDir, 'config')
    }
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
