// What an `origin` remote has to be, said once for every process that asks.
// The hash of the normalised origin is the project identity. A URL normalises to
// `host/path`; a path is an identity only if both Macs reach the repository at
// the same absolute path, spelled the same way, so nothing is folded that could
// name a different directory and every surface shows the exact string hashed.
// A normalised path starts with `/` and a URL never does, so the two cannot
// collide and every URL key stays byte-for-byte what it was. A path is never a
// default: the origin is whatever git already has.

/** What kind of place an origin names, once it is known to be usable. */
export type OriginKind = 'url' | 'path'

/**
 * The remote's identity, spelled one way: for a URL the scheme, credentials, port,
 * trailing `.git` and host case are folded away; for a path see `normalisePath`.
 * Defined via `checkOrigin` so the key and what the panel accepts are one rule.
 */
export function normaliseRemote(remote: string): string | undefined {
  const checked = checkOrigin(remote)
  return checked.ok ? checked.normalised : undefined
}

export type OriginCheck =
  | {
      ok: true
      kind: OriginKind
      /**
       * What to give git. A URL is kept as typed (ssh against https is the user's
       * choice); a path is the normalised one, so `git remote -v` and the hash agree.
       */
      remote: string
      /** The string that gets hashed, which for a path is the thing to show. */
      normalised: string
    }
  /** Why it was refused, as a clause a sentence can be built from. */
  | { ok: false; reason: string }

/**
 * Whether this is an origin teamree can match against a teammate's, and why not.
 * Path cases go first: `file:/srv/app` and `/Volumes/a:b/app.git` would otherwise
 * parse as URLs naming a machine nobody has.
 */
export function checkOrigin(raw: string): OriginCheck {
  const remote = raw.trim()
  if (remote === '') {
    return { ok: false, reason: 'type the URL you both cloned, or the path the repository is mounted at on both Macs' }
  }
  if (pathShaped(remote)) {
    const path = normalisePath(remote)
    if (!path.ok) return path
    return { ok: true, kind: 'path', remote: path.path, normalised: path.path }
  }
  // Before the space rule: `ext::sh -c id` has a space in it, and the transport
  // is what is wrong with it.
  const transport = checkTransport(remote)
  if (!transport.ok) return transport
  if (/\s/.test(remote)) return { ok: false, reason: 'a remote URL has no spaces in it' }
  const normalised = normaliseUrl(remote)
  if (normalised === undefined) {
    return {
      ok: false,
      reason:
        'that is neither a URL with a host in it, like https://github.com/you/repo.git, nor a path starting with /'
    }
  }
  return { ok: true, kind: 'url', remote, normalised }
}

/**
 * The transports teamree will hand git. `file` is never reached inside this file
 * (`checkOrigin` reads `file:` as a path first); it is for a caller holding a raw
 * `.git/config` remote that asks only this question and must get the same answer.
 */
const TRANSPORTS = new Set(['https', 'http', 'ssh', 'git', 'file'])

export type TransportCheck = { ok: true } | { ok: false; reason: string }

/**
 * Whether the remote names a transport teamree means to allow, or why not.
 *
 * `<name>::<address>` hands the address to `git-remote-<name>` (`ext::` runs
 * whatever it is given) and a scheme git has no transport for is sent looking
 * for the same kind of helper, so both spellings name a program, not a place.
 * git's own `protocol.ext.allow` default is configurable and invisible from
 * here, so it is not the only defence; this is an allowlist because the next
 * helper is one nobody here has heard of. A transport is only named where git
 * itself reads one — scheme characters then `://` or `::` — because scp-style
 * `gitlab.example:team/api.git` is a real remote, and everything else falls
 * through to the grammar in `checkOrigin`.
 */
export function checkTransport(raw: string): TransportCheck {
  const named = /^([A-Za-z][A-Za-z0-9+.-]*)(::|:\/\/)/.exec(raw.trim())
  if (named === null) return { ok: true }
  const name = (named[1] ?? '').toLowerCase()
  // `::` is the helper spelling whatever follows it, so a name is allowed only
  // in the spelling that is a URL: `https::` is not https.
  if (named[2] === '://' && TRANSPORTS.has(name)) return { ok: true }
  return {
    ok: false,
    reason:
      `"${name}" is not a transport teamree hands git. git's remote syntax includes spellings that name a ` +
      'program rather than a place — `name::address` hands the address to one, and a scheme git has no transport ' +
      'of its own for sends it looking for one — so an origin is held to https, http, ssh, git, file, an ' +
      'scp-style host:path, or a path on this Mac'
  }
}

/**
 * Whether this remote names somewhere on a disk rather than on a network. A shape
 * test, not a lookup: it runs while somebody is typing, and against remotes whose
 * volume is not mounted this minute. `normalisePath` answers all it says yes to.
 */
function pathShaped(remote: string): boolean {
  // `file:` in any spelling, including `file:/srv/app`, which would otherwise
  // parse as a host called `file`.
  if (/^file:/i.test(remote)) return true
  if (/^(?:\/|~|\.{1,2}\/)/.test(remote)) return true
  // A drive letter would otherwise read as a host called `c`; refuse it as a path.
  if (/^[A-Za-z]:[\\/]/.test(remote)) return true
  // git reads a remote with no scheme and no scp-style host as a path, but only
  // with a separator in it: a bare word was meant as neither.
  return !remote.includes(':') && remote.includes('/')
}

type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * A filesystem origin, folded only where folding cannot change which directory
 * is named: repeated slashes, a trailing slash and `.` segments go. Case stays
 * (APFS and network volumes can be case-sensitive; two teams quietly becoming
 * one is the failure this file exists to prevent). A trailing `.git` stays: on
 * a disk `app` and `app.git` are two directories. The Unicode form stays, for
 * the reason case does. Symlinks are not resolved and `..` is refused, not
 * folded: `a/link/../b` names a different directory once `link` is a symlink.
 */
function normalisePath(remote: string): PathCheck {
  let path = remote
  let fromUrl = false
  if (/^file:/i.test(remote)) {
    fromUrl = true
    let url: URL
    try {
      url = new URL(remote)
    } catch {
      return { ok: false, reason: 'that file:// URL cannot be read as a path — give the path plainly, starting with /' }
    }
    const host = url.hostname.toLowerCase()
    if (host !== '' && host !== 'localhost') {
      return {
        ok: false,
        reason:
          `a file:// URL with a host in it (${url.hostname}) names a machine rather than a directory on this Mac — ` +
          'give the path the volume is mounted at here, starting with /'
      }
    }
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      return {
        ok: false,
        reason: 'that file:// URL has an escape in it teamree cannot decode — give the path plainly, starting with /'
      }
    }
  }

  // About to be hashed, printed and pasted to a teammate: an invisible
  // character goes wrong silently.
  if (/[\u0000-\u001F\u007F]/.test(path)) {
    return { ok: false, reason: 'that path has a control character in it, which no directory on a Mac is named with' }
  }
  if (path.startsWith('~')) {
    return {
      ok: false,
      reason:
        '~ is a different directory for every account, so two machines could never agree on what it named — give ' +
        'the path the repository is mounted at, starting with /'
    }
  }
  if (!path.startsWith('/')) {
    return {
      ok: false,
      reason:
        'a relative path names a different directory depending on where it is read from — give the path the ' +
        'repository is mounted at, starting with /'
    }
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  // Against what was written too: the URL parser folds `..` out of a `file://`
  // URL, escapes and all, before this could see it.
  if (segments.includes('..') || hasParentSegment(fromUrl ? decodeIfPossible(remote) : remote)) {
    return {
      ok: false,
      reason:
        'a path with a .. segment in it lands somewhere different depending on the links along the way, so teamree ' +
        'will not fold one — give the path with no .. in it'
    }
  }
  if (segments.length === 0) return { ok: false, reason: 'that is the root of the disk rather than a repository on it' }
  return { ok: true, path: `/${segments.join('/')}` }
}

/** Whether `..` appears as a segment of its own, rather than inside a name. */
function hasParentSegment(text: string): boolean {
  return /(?:^|\/)\.\.(?:\/|$)/.test(text)
}

/** The same text with its escapes read, or the text itself when they do not parse. */
function decodeIfPossible(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * Host and path, out of every spelling of a URL a clone produces. Path case is
 * folded with host case; changing that would move every existing team's key.
 */
function normaliseUrl(remote: string): string | undefined {
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(remote)
  const [host, path] = scp
    ? [scp[1] ?? '', scp[2] ?? '']
    : (() => {
        try {
          const url = new URL(remote)
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

/** What a teammate has to match, as the sentence that says it; only paths need one. */
export function pathIdentityNote(path: string): string {
  return (
    `Your teammate’s origin has to be this exact path, ${path}, character for character. Nothing on either Mac ` +
    'can tell that a volume mounted at two different paths is one repository, so two spellings mean two projects ' +
    'and neither machine ever sees the other.'
  )
}
