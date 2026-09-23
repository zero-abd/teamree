// Where a branch that was just pushed gets read: the forge's "start a review"
// page, derived from the remote URL and the branch. Nothing touches the network,
// and an unrecognised host gets no URL rather than a plausible one (GitHub Enterprise
// is unrecognisable by name; `gitlab.<company>` is GitLab's own naming; Bitbucket is `bitbucket.org` only).

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
 * The page to open a review on, or nothing: for an unrecognised host, an unparseable
 * remote URL, or a push of the base branch itself (an empty diff).
 */
export function reviewUrl(options: ReviewUrlOptions): string | undefined {
  const branch = bareRef(options.branch, options.remote ?? 'origin')
  const base = bareRef(options.baseRef, options.remote ?? 'origin')
  if (branch.length === 0 || base.length === 0 || branch === base) return undefined

  const remote = parseRemoteUrl(options.remoteUrl)
  if (remote === null) return undefined

  const repository = `https://${remote.host}/${remote.path}`
  // `encodeURIComponent` on every branch name: `feature/#3` and `fix?x` are legal
  // git refs, and one of them ends a URL early.
  const from = encodeURIComponent(branch)
  const into = encodeURIComponent(base)

  switch (forgeOf(remote.host)) {
    case 'github':
      // `expand=1` makes it the form rather than the diff.
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
 * Host and repository path from any of the three shapes git accepts. The scp-like
 * `git@host:owner/repo.git` is not a URL for `new URL`, and is what "clone with SSH" hands out.
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
  // Two segments at least: a forge URL names an owner and a repository.
  if (host.length === 0 || path.split('/').filter(Boolean).length < 2) return null
  return { host: host.toLowerCase(), path }
}

/** A ref as the forge names it: no `refs/heads/`, and no remote in front — the forge has never heard of `origin`. */
function bareRef(ref: string, remote: string): string {
  const withoutRefs = ref.trim().replace(/^refs\/heads\//, '')
  return withoutRefs.startsWith(`${remote}/`) ? withoutRefs.slice(remote.length + 1) : withoutRefs
}
