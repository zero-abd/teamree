// What an `origin` remote has to be, said once for every process that asks.
//
// Two checkouts are the same project when the hash of their normalised origin
// matches, so the identity is a remote URL and nothing else. A path on this
// disk is a perfectly good git remote and a completely useless project
// identity: nobody else can clone it, so nobody else can ever hash to the same
// key. That is the one refusal a person setting this up will actually hit, and
// it has to be the same refusal wherever it is reached — in the field while
// they are still typing, and in the runtime before git is run.

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

export type OriginCheck =
  | { ok: true; url: string; normalised: string }
  /** Why it was refused, as a clause a sentence can be built from. */
  | { ok: false; reason: string }

/** A local path dressed as a remote: the one refusal worth its own sentence. */
const LOOKS_LIKE_A_PATH = /^(?:[~.]{0,2}\/|file:\/\/|[A-Za-z]:[\\/])/

/**
 * Whether this is an origin teamree can match against a teammate's, and why not
 * when it is not.
 *
 * `file://` and a bare path are named separately from "this is not a URL"
 * because they are not typing mistakes: they are somebody answering the
 * question they thought was being asked, and the answer to them is a different
 * sentence.
 */
export function checkOriginUrl(raw: string): OriginCheck {
  const url = raw.trim()
  if (url === '') return { ok: false, reason: 'type the URL you and your teammates both cloned' }
  if (/\s/.test(url)) return { ok: false, reason: 'a remote URL has no spaces in it' }
  if (LOOKS_LIKE_A_PATH.test(url)) {
    return {
      ok: false,
      reason: 'that is a path on this disk, and a path is not a URL your teammates could clone'
    }
  }
  const normalised = normaliseRemote(url)
  if (normalised === undefined) {
    return { ok: false, reason: 'that is not a URL with a host in it, like https://github.com/you/repo.git' }
  }
  return { ok: true, url, normalised }
}
