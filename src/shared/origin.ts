// What an `origin` remote has to be, said once for every process that asks.
//
// Two checkouts are the same project when the hash of their normalised origin
// matches, so the origin is the identity and there is nothing else underneath
// it. Most origins are URLs, and two people who cloned one repository over ssh
// and over https agree about it without having to agree about anything else:
// the host and the path are a fact about a server both machines can name.
//
// A repository shared over a mounted volume or a directory on a file server has
// no such server to name, and sharing one that way is an ordinary thing for a
// team to do. What it has instead is a path, and a path is a fact about a mount
// rather than about the repository: nothing readable from this Mac can show
// that `/Volumes/team/app.git` here and `/Users/ada/mnt/team/app.git` there are
// one directory. There is no third party to ask, and a volume UUID or an inode
// answers a question about this machine's mount rather than about the
// repository two people share.
//
// So a path is an identity on exactly one condition, and the condition is said
// out loud rather than hidden: **both Macs have to reach the repository at the
// same absolute path, spelled the same way.** That much is checkable, because
// it is the string being hashed, and the rest of this file follows from
// refusing to pretend to more. Nothing is folded away that could name a
// different directory on some filesystem, and every surface that sets a path
// origin shows the exact string it will hash, so the person at the other end is
// given it rather than left to guess at it.
//
// Two properties the rules below are written to keep:
//
// **A path can never collide with a URL.** A normalised URL is `host/path` with
// a host in it, so it never begins with a slash; a normalised path always does.
// That leading slash is the whole namespace, and it is free: it also leaves
// every URL's key byte-for-byte what it was before paths were allowed here,
// which matters because a key that quietly changed is a team that quietly stops
// meeting.
//
// **A path is never a default.** The origin is whatever git already has. An
// origin that is a URL is read as a URL and nothing about it changes.

/** What kind of place an origin names, once it is known to be usable. */
export type OriginKind = 'url' | 'path'

/**
 * The remote's identity, spelled one way.
 *
 * Two people clone the same repository over ssh and https and mean the same
 * thing, so for a URL the scheme, credentials, port, a trailing `.git` and the
 * case of the host are all normalised away; what is left is host and path,
 * which is what two clones of one repository agree on. For a path, far less is
 * normalised away and `normalisePath` says why of each one.
 *
 * Defined in terms of `checkOrigin` rather than beside it, because a remote
 * this returns a key for and a remote the panel accepts have to be the same
 * remote: two spellings of one rule is how somebody gets told two different
 * things about one origin.
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
       * What to give git. A URL is kept exactly as it was typed, because the
       * spelling carries a choice — ssh against https — that is the user's and
       * not this file's. A path is the normalised one, so that what
       * `git remote -v` shows and what gets hashed are the same characters.
       */
      remote: string
      /** The string that gets hashed, which for a path is the thing to show. */
      normalised: string
    }
  /** Why it was refused, as a clause a sentence can be built from. */
  | { ok: false; reason: string }

/**
 * Whether this is an origin teamree can match against a teammate's, and why not
 * when it is not.
 *
 * The path cases are answered before anything tries to read a URL out of the
 * string, because several of them would otherwise parse as one: `file:/srv/app`
 * has a scheme in it, and `/Volumes/a:b/app.git` has a colon in it, and either
 * read as a host would be an identity that names a machine nobody has.
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
 * Whether this remote names somewhere on a disk rather than somewhere on a
 * network.
 *
 * A shape test and not a lookup: it runs while somebody is still typing, and it
 * runs against remotes git has for repositories whose volume is not mounted
 * this minute. Everything it says yes to is answered by `normalisePath`, which
 * is where a relative path or a `~` gets its own sentence rather than being
 * lumped in with "that is not a URL".
 */
function pathShaped(remote: string): boolean {
  // `file:` in any of its spellings, including `file:/srv/app`, which has only
  // one slash and would otherwise parse as a host called `file`.
  if (/^file:/i.test(remote)) return true
  if (/^(?:\/|~|\.{1,2}\/)/.test(remote)) return true
  // A drive letter is not a path on this Mac and is not a URL either, and left
  // alone it would read as a host called `c`. It is here so that it is refused
  // by the half of this file that talks about directories.
  if (/^[A-Za-z]:[\\/]/.test(remote)) return true
  // What git itself does with a remote that has no scheme and no scp-style
  // host: read it as a path. Only when there is a separator in it, though — a
  // bare word is something nobody meant as either, and calling it a filesystem
  // path would answer a question this person did not ask.
  return !remote.includes(':') && remote.includes('/')
}

type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * A filesystem origin, folded only where folding cannot change which directory
 * is named.
 *
 * Repeated slashes, a trailing slash and a `.` segment name the same directory
 * on every filesystem there is, so they go. Nothing else does, and the things
 * that stay are the interesting half:
 *
 * **Case stays.** macOS volumes are usually case-insensitive and are not always
 * — APFS can be formatted case-sensitive, and a network volume answers to
 * whatever is serving it. Folding case would merge `/Volumes/src/Repo` and
 * `/Volumes/src/repo`, which on such a volume are two repositories, and two
 * teams quietly becoming one is the single failure this file exists to prevent.
 * So two people who spell the path with different case do not meet — and
 * because the panel prints the spelling it hashes, that is something to notice
 * beforehand rather than to discover afterwards.
 *
 * **A trailing `.git` stays.** On a hosting service `…/app` and `…/app.git` are
 * one repository by convention, which is why the URL rule drops it. On a disk
 * they are two directories, and a bare `app.git` sitting beside a working
 * checkout `app` is exactly how somebody lays this out.
 *
 * **The Unicode form of a name stays**, for the reason case does: two spellings
 * of one accent are the same file on macOS and need not be on a server. Paste
 * the path from the person who set it up rather than retyping it.
 *
 * **Symlinks are not resolved, and a `..` segment is refused rather than
 * folded.** Collapsing `a/link/../b` lexically names a different directory the
 * moment `link` is a symlink, and resolving it for real would make the identity
 * a fact about this Mac's disk instead of about the spelling both people hold.
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

  // A control character is never in a path somebody means, and this string is
  // about to be hashed, printed in a panel and pasted into a message to a
  // teammate — three places where an invisible character is a thing that goes
  // wrong silently rather than loudly.
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
  // Against what was written as well as against what came back from the
  // parser: a `file://` URL has its `..` folded out by the URL parser itself,
  // escapes and all, before any of this could see it — and folding one is
  // precisely what must not happen here.
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
 * Host and path, out of every spelling of a URL a clone produces.
 *
 * The case of the path is folded along with the case of the host, which is a
 * hosting service's convention rather than a filesystem's: it is how this
 * behaved before paths were allowed here, and changing it now would move every
 * existing team's project key for no gain.
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

/**
 * What a teammate has to match, as the sentence that says it.
 *
 * A URL team needs no such sentence — theirs is the case where two spellings of
 * one repository already agree — so this is about paths, and it is deliberately
 * blunt about the one thing the design cannot do for them.
 */
export function pathIdentityNote(path: string): string {
  return (
    `Your teammate’s origin has to be this exact path, ${path}, character for character. Nothing on either Mac ` +
    'can tell that a volume mounted at two different paths is one repository, so two spellings mean two projects ' +
    'and neither machine ever sees the other.'
  )
}
