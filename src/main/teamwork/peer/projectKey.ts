// What makes two checkouts on two machines the same project.
//
// Project ids are generated per installation, so they say nothing across a
// wire. `docs/teamwork.md` already answers what does: "a project is already a
// git repository that several people push to". The thing several people push
// to is the remote, so the remote is the identity.
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
import type { GitRunner } from '../../git/gitProcess'

/** Domain separation, so this hash can never be mistaken for another one. */
const KEY_PREFIX = 'teamree/project/v1\n'

export type ProjectKeyResult =
  | { ok: true; key: string }
  /** Why this project cannot be matched to a teammate's, for the user to read. */
  | { ok: false; reason: string }

/**
 * The remote's identity, spelled one way.
 *
 * Two people clone the same repository over ssh and https and mean the same
 * thing, so scheme, credentials, port, a trailing `.git` and case in the host
 * are all normalised away. What is left is host and path, which is what two
 * clones of one repository agree on.
 */
export function normaliseRemote(remote: string): string | undefined {
  const trimmed = remote.trim()
  if (!trimmed) return undefined

  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed)
  const [host, path] = scp
    ? [scp[1] ?? '', scp[2] ?? '']
    : (() => {
        try {
          const url = new URL(trimmed)
          return [url.hostname, url.pathname]
        } catch {
          return [undefined, undefined]
        }
      })()

  if (host === undefined || path === undefined) return undefined
  const cleanHost = host.toLowerCase()
  const cleanPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  if (!cleanHost || !cleanPath) return undefined
  return `${cleanHost}/${cleanPath}`
}

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

  const normalised = normaliseRemote(remote)
  if (normalised === undefined) {
    return { ok: false, reason: 'the origin remote is not a URL teamree can compare with a teammate’s' }
  }
  return { ok: true, key: projectKeyFor(normalised) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
