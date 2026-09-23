// Where a branch that was just pushed gets read by somebody else.
//
// A push ends with the work on a server and the person who pushed it looking at
// a terminal. The page that closes that gap — GitHub's compare view, GitLab's
// new merge request, Bitbucket's new pull request — is derivable from two
// things this app already holds: the URL the remote is known by, and the branch
// that went up. So it is derived, here, and nothing is asked of anyone.
//
// **Nothing here touches the network.** Whether a pull request for this branch
// already exists is a question only the forge's API can answer, and answering
// it would mean credentials, a request on the push path, and a failure mode for
// a link. So this is a link to the page that *starts* a review; a forge that
// already has one redirects there itself, which is the forge's job.
//
// The other half of that discipline is refusing to guess. A host this cannot
// recognise gets no URL rather than a plausible one: a button that opens the
// wrong page is worse than no button, because the wrong page looks like an
// answer. GitHub Enterprise is the clearest case — an installation is reachable
// at whatever name its company chose, and there is nothing in `git@git.acme.
// example/o/r.git` that says which software is behind it.
//
// GitLab is the one exception, and it is a narrow one: `gitlab.<company>.<tld>`
// is the naming its own documentation uses for a self-managed install, so a
// host whose first label is `gitlab` is recognised. Bitbucket is `bitbucket.org`
// and only that — Data Center installs answer on a different URL shape
// entirely, so matching them on a name would be matching them on nothing.

/** What the review page needs to know, all of it already on this machine. */
export type ReviewUrlOptions = {
  /** The remote's URL, as `git remote get-url` reports it. */
  remoteUrl: string
  /** The branch that was pushed. */
  branch: string
  /** The project's base ref, `origin/main` and `main` both being ordinary. */
  baseRef: string
  /** The remote the push named, whose prefix a base ref may carry. */
  remote?: string
}

/**
 * The page to open a review on, or nothing at all.
 *
 * Nothing is the answer for a host that is not recognised, for a remote URL
 * that does not parse, and for a push of the base branch itself — there is no
 * review to open for a branch against itself, and offering one would be an
 * invitation to open an empty diff.
 */
export function reviewUrl(options: ReviewUrlOptions): string | undefined {
  const branch = bareRef(options.branch, options.remote ?? 'origin')
  const base = bareRef(options.baseRef, options.remote ?? 'origin')
  if (branch.length === 0 || base.length === 0 || branch === base) return undefined

  const remote = parseRemoteUrl(options.remoteUrl)
  if (remote === null) return undefined

  const repository = `https://${remote.host}/${remote.path}`
  // Every branch name reaching a query string or a path segment goes through
  // `encodeURIComponent`: `feature/#3` and `fix?x` are legal git refs, and one
  // of them ends a URL early.
  const from = encodeURIComponent(branch)
  const into = encodeURIComponent(base)

  switch (forgeOf(remote.host)) {
    case 'github':
      // `expand=1` is what makes it the form rather than the diff, which is the
      // difference between "look at this" and "open a review".
      return `${repository}/compare/${into}...${from}?expand=1`
    case 'gitlab':
      return (
        `${repository}/-/merge_requests/new` +
        `?merge_request[source_branch]=${from}&merge_request[target_branch]=${into}`
      )
    case 'bitbucket':
      return `${repository}/pull-requests/new?source=${from}&dest=${into}`
    default:
      return undefined
  }
}

type Forge = 'github' | 'gitlab' | 'bitbucket' | null

function forgeOf(host: string): Forge {
  if (host === 'github.com') return 'github'
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab'
  if (host === 'bitbucket.org') return 'bitbucket'
  return null
}

type RemoteAddress = { host: string; path: string }

/**
 * The host and repository path in a remote URL, in any of the three shapes git
 * accepts for one.
 *
 * The scp-like `git@host:owner/repo.git` is not a URL and `new URL` does not
 * read it — it is the shape a forge's "clone with SSH" button hands out, so it
 * is the one most likely to be in a repository's config.
 */
function parseRemoteUrl(url: string): RemoteAddress | null {
  const text = url.trim()
  if (text.length === 0) return null

  if (!text.includes('://')) {
    const scp = /^(?:[^/@]+@)?([^/:]+):(.+)$/.exec(text)
    if (scp === null) return null
    return address(scp[1] as string, scp[2] as string)
  }

  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
  return address(parsed.hostname, parsed.pathname)
}

function address(host: string, rawPath: string): RemoteAddress | null {
  const path = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  // Two segments at least: a forge URL names an owner and a repository, and a
  // path with one segment is not a repository on any of these.
  if (host.length === 0 || path.split('/').filter(Boolean).length < 2) return null
  return { host: host.toLowerCase(), path }
}

/**
 * A ref as the forge names it: no `refs/heads/`, and no remote in front of it.
 *
 * A project's base ref is written the way a person would type it at git, which
 * is `origin/main` as often as `main`. The forge has never heard of the remote
 * this machine calls `origin`; it has a branch called `main`.
 */
function bareRef(ref: string, remote: string): string {
  const withoutRefs = ref.trim().replace(/^refs\/heads\//, '')
  return withoutRefs.startsWith(`${remote}/`) ? withoutRefs.slice(remote.length + 1) : withoutRefs
}
