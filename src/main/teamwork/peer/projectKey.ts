// What makes two checkouts on two machines the same project.
//
// Project ids are generated per installation, so they say nothing across a
// wire. `docs/teamwork.md` already answers what does: "a project is already a
// git repository that several people push to". The thing several people push
// to is the remote, so the remote is the identity — a URL when there is a
// server to name, and otherwise the path a shared volume is mounted at, which
// is an identity exactly as far as two Macs spell it the same way. Which
// foldings are safe, and why a normalised path can never be hashed to a URL's
// key, is argued once in `@shared/origin` and applied here.
//
// It is hashed rather than sent. A session is pairwise — one per pair of
// teammates, covering every repository the two of them happen to share — so a
// presence message that named remotes in the clear would tell a teammate the
// URLs of repositories they are not a member of. A hash matches the repository
// they *do* share and discloses nothing about the rest.
//
// A project with no `origin` simply does not take part, and says so. Guessing
// at some other remote, or falling back to a root commit, would let two peers
// disagree about which rule applied and silently show each other nothing.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitRunner } from '../../git/gitProcess'
import { checkOrigin } from '../../../shared/origin'

/** Domain separation, so this hash can never be mistaken for another one. */
const KEY_PREFIX = 'teamree/project/v1\n'

export type ProjectKeyResult =
  /**
   * `url` is the origin as it is to be named — git's own spelling of a URL, and
   * the normalised spelling of a path, which is the one a teammate has to be
   * given character for character.
   */
  | { ok: true; key: string; url: string }
  /** Why this project cannot be matched to a teammate's, for the user to read. */
  | { ok: false; reason: string }

/**
 * The remote's identity, spelled one way.
 *
 * The rule itself is in `@shared/origin`, because the panel that offers to add
 * an origin has to refuse exactly what this would refuse, and re-exported here
 * because this module is where the rest of the runtime looks for it.
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
    if (exitCode !== 0) {
      return {
        ok: false,
        reason:
          'this project has no origin remote, so teamree cannot tell it is the same repository your teammates have'
      }
    }
    remote = stdout.trim()
  } catch (error) {
    return { ok: false, reason: `git could not be asked for the origin remote: ${messageOf(error)}` }
  }

  const checked = checkOrigin(remote)
  if (!checked.ok) {
    // The refusal names the origin git actually has before it says anything
    // about it. What is wrong here is never a typing mistake — nobody types
    // this field, they cloned or they mounted — so the sentence has to be one
    // somebody can act on without first working out which of their remotes it
    // is talking about.
    return { ok: false, reason: `origin is ${remote}, and ${checked.reason}` }
  }
  // The normalised spelling for a path, git's own for a URL: `checkOrigin` says
  // why, and an invitation that has to tell a teammate what to match wants the
  // characters that are being hashed rather than the ones that were typed.
  return { ok: true, key: projectKeyFor(checked.normalised), url: checked.remote }
}

/**
 * A stamp of the file `origin` is configured in, or `undefined` when there is
 * no repository there to read.
 *
 * `readProjectKey` costs a git subprocess, so nothing can afford to call it on
 * every read of the status. This costs a `stat`, and changes exactly when
 * asking git again could say something new — which is what lets a cached key
 * be trusted until it cannot.
 */
export function originMark(projectPath: string): string | undefined {
  const path = gitConfigPath(projectPath)
  if (path === undefined) return undefined
  try {
    const stats = statSync(path)
    // The inode as well as the clock: git rewrites its config by renaming a
    // lock file over it, so the file's identity moves even within one
    // millisecond, and a filesystem with a coarse mtime would otherwise hide a
    // `git remote add` made immediately after a read.
    return `${path}\u0000${stats.ino}\u0000${stats.mtimeMs}\u0000${stats.size}`
  } catch {
    return undefined
  }
}

/**
 * Where git keeps the remotes for a checkout.
 *
 * A linked worktree's `.git` is a file pointing at a directory of its own, and
 * that directory borrows the repository's config rather than holding one, so
 * the answer is never simply `<checkout>/.git/config`.
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
