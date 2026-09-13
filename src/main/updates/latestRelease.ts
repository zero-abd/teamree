// Asking GitHub what the newest published release is, and refusing to believe
// most of what comes back.
//
// Everything below the request is a trust boundary. The response is JSON from
// the internet: a proxy, a captive portal or a compromised token can put
// anything in it, and two of the fields end up somewhere dangerous — the notes
// are shown to the user, and the download URL is handed to their browser. So
// nothing is used as it arrives. The tag has to look like one of this project's
// tags, the URL has to be an address on github.com under this repository, the
// notes are flattened to plain text and cut to a length, and the body is read
// through a byte budget so a response that never ends cannot be a response that
// never ends.
//
// It reads the releases API rather than the atom feed or the download page
// because that is the only one of the three that says which release is a
// pre-release, and that distinction is what keeps a candidate away from
// somebody who is not testing candidates.

import { z } from 'zod'
import { compareVersions, isPrereleaseVersion, parseVersion, type Version } from './semver'

/** Where the releases are. `owner/name`, as gh spells it. */
export const UPDATE_REPOSITORY = 'zero-abd/teamree'

export const GITHUB_API_ORIGIN = 'https://api.github.com'

/** The only host a download link is allowed to lead to. */
export const RELEASE_HOST = 'github.com'

/**
 * How long the check may take before it is abandoned.
 *
 * Nothing waits on this — it runs long after the window is up — so the timeout
 * is not about responsiveness. It is about a socket on a captive-portal network
 * that accepts a connection and then says nothing at all, which without a
 * deadline is a request that is still outstanding when the user quits.
 */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * The most of a response body that will be read.
 *
 * A release with generous notes is a few kilobytes. This is two orders of
 * magnitude above that and still small enough that a body claiming to be
 * endless is abandoned rather than accumulated.
 */
export const MAX_RESPONSE_BYTES = 256 * 1024

/** The most release notes that are shown. Past it the reader gets the link. */
export const MAX_NOTES_CHARS = 4_000

/** Releases looked at when picking the newest on the pre-release channel. */
export const PRERELEASE_PAGE_SIZE = 20

/**
 * Which releases this build is a candidate for being offered.
 *
 * `stable` asks for `/releases/latest`, which GitHub defines as the newest
 * release that is neither a draft nor a pre-release — the filtering is done by
 * the API, and checked again here, because the two agreeing is not something
 * this app should have to assume.
 */
export type ReleaseChannel = 'stable' | 'prerelease'

/** A release, after everything untrustworthy about it has been dealt with. */
export type LatestRelease = {
  /** The version the tag names, e.g. `0.2.0`. */
  version: string
  /** The tag itself, e.g. `v0.2.0`. */
  tag: string
  /** Whether GitHub marks it a pre-release. */
  prerelease: boolean
  /** The notes, as plain text, or null when the release carries none. */
  notes: string | null
  /** The `.dmg` to download, or null when the release published none. */
  downloadUrl: string | null
  /** The release's own page, built from the tag rather than taken from the API. */
  releaseUrl: string
  /** Epoch milliseconds, or null when the date was missing or unreadable. */
  publishedAt: number | null
}

/**
 * Exactly the fields that are used, and every one of them optional.
 *
 * A schema that demanded the whole shape would turn an API that added or
 * renamed something into a check that fails forever, silently, on everybody's
 * machine at once. So this asks for very little and the code below decides what
 * it can do without.
 */
const ReleaseSchema = z.object({
  tag_name: z.string().optional(),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullish(),
  assets: z
    .array(z.object({ name: z.string().optional(), browser_download_url: z.string().optional() }).passthrough())
    .optional()
})

type RawRelease = z.infer<typeof ReleaseSchema>

export type LatestReleaseOptions = {
  channel: ReleaseChannel
  /** Defaults to this project's. Named so a test never reaches the real one. */
  repository?: string
  /** Defaults to the global `fetch`, which is Node's own on this runtime. */
  fetchImpl?: typeof fetch
  /** Goes in the User-Agent, which GitHub requires a request to carry. */
  version: string
}

/**
 * The newest release this build could be offered, or null when there is none.
 *
 * Throws when the check could not be made — no network, a refusal, a body that
 * is not JSON. The caller's job is to write that down and say nothing, so the
 * message here is for the log rather than for a window.
 */
export async function readLatestRelease(options: LatestReleaseOptions): Promise<LatestRelease | null> {
  const repository = options.repository ?? UPDATE_REPOSITORY
  const fetchImpl = options.fetchImpl ?? fetch

  const url =
    options.channel === 'stable'
      ? `${GITHUB_API_ORIGIN}/repos/${repository}/releases/latest`
      : `${GITHUB_API_ORIGIN}/repos/${repository}/releases?per_page=${PRERELEASE_PAGE_SIZE}`

  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      // Pinned, because an unversioned request is one that changes shape on
      // GitHub's schedule rather than on this project's.
      'x-github-api-version': '2022-11-28',
      // GitHub refuses a request without one, and an identifiable agent is also
      // how a maintainer would recognise this app in their own logs.
      'user-agent': `teamree/${options.version}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!response.ok) {
    // The status is the whole message on purpose. 403 with no remaining quota
    // is the rate limit, 404 is a repository that has no releases yet, and
    // neither is something to put in front of somebody who is working.
    throw new Error(`GitHub answered ${response.status} for ${options.channel} releases`)
  }

  const parsed: unknown = JSON.parse(await readBounded(response))

  if (options.channel === 'stable') {
    const release = ReleaseSchema.safeParse(parsed)
    if (!release.success) return null
    return usable(release.data, repository, 'stable')
  }

  if (!Array.isArray(parsed)) return null
  const candidates = parsed
    .map((entry) => ReleaseSchema.safeParse(entry))
    .flatMap((result) => (result.success ? [result.data] : []))
    .flatMap((raw) => {
      const release = usable(raw, repository, 'prerelease')
      return release === null ? [] : [release]
    })

  return highest(candidates)
}

/**
 * One release, if it is one this app can act on at all.
 *
 * A draft is not published and cannot be downloaded; a tag that is not a
 * version cannot be compared to this build's; and on the stable channel a
 * release GitHub has marked a pre-release is not offered whatever endpoint it
 * arrived from, because `/releases/latest` excluding them is GitHub's promise
 * rather than this app's guarantee.
 */
function usable(raw: RawRelease, repository: string, channel: ReleaseChannel): LatestRelease | null {
  if (raw.draft === true) return null
  const prerelease = raw.prerelease === true
  if (channel === 'stable' && prerelease) return null

  const tag = raw.tag_name?.trim() ?? ''
  const version = parseVersion(tag)
  // A tag is a path segment in the two URLs below, so this refusal is what
  // keeps `../` and a query string out of an address the browser is handed.
  if (version === null || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) return null

  return {
    version: version.raw,
    tag,
    // GitHub's own flag when it is set, and the tag's shape when it is not: a
    // release cut as `v0.3.0-rc.1` is a candidate whether or not the box was
    // ticked, and the tag is the half of that pair this project controls.
    prerelease: prerelease || isPrereleaseVersion(version),
    notes: plainText(raw.body ?? ''),
    downloadUrl: diskImage(raw, repository),
    // Built here rather than read from `html_url`, so the one link that is
    // always offered is one this app composed out of a tag it has checked.
    releaseUrl: `https://${RELEASE_HOST}/${repository}/releases/tag/${tag}`,
    publishedAt: epoch(raw.published_at)
  }
}

/** The newest of several releases, by precedence rather than by list order. */
function highest(releases: readonly LatestRelease[]): LatestRelease | null {
  let best: { release: LatestRelease; version: Version } | null = null
  for (const release of releases) {
    const version = parseVersion(release.version)
    if (version === null) continue
    if (best === null || compareVersions(version, best.version) > 0) best = { release, version }
  }
  return best?.release ?? null
}

/**
 * The macOS image among the release's assets, or null.
 *
 * Checked against the repository it claims to belong to, because this URL is
 * the one piece of the response that is handed to the user's browser. A
 * download link pointing somewhere else is not a release asset however much the
 * JSON around it says it is.
 */
function diskImage(raw: RawRelease, repository: string): string | null {
  for (const asset of raw.assets ?? []) {
    if (asset.name === undefined || !asset.name.endsWith('.dmg')) continue
    const url = asset.browser_download_url
    if (url === undefined) continue
    if (isReleaseDownload(url, repository)) return url
  }
  return null
}

/**
 * Whether a URL is an address in this repository's releases, served over TLS.
 *
 * Deliberately narrow. The alternative — "it starts with https://github.com" —
 * is passed by `https://github.com.example.invalid/` on a string comparison,
 * which is exactly the mistake a parsed URL cannot make.
 */
export function isReleaseDownload(candidate: string, repository: string = UPDATE_REPOSITORY): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname !== RELEASE_HOST) return false
  return url.pathname.startsWith(`/${repository}/releases/`)
}

/**
 * The response body, up to the budget, abandoned past it.
 *
 * Read through the stream rather than with `response.text()` because `text()`
 * has already buffered the whole thing by the time its length could be
 * checked — which makes a cap applied afterwards a cap on what is shown rather
 * than on what is held.
 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body
  if (body === null) return ''

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error(`the release list was larger than ${MAX_RESPONSE_BYTES} bytes`)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    // Releases the connection whether the body ended or was abandoned.
    await reader.cancel().catch(() => {})
  }
  return text + decoder.decode()
}

/**
 * Release notes as something safe to put on screen.
 *
 * The body is markdown, and markdown is a document format that carries HTML.
 * Nothing here renders it: control characters that could rewrite a line of
 * terminal-adjacent UI are dropped, the text is cut to a length, and what
 * survives is a string the renderer prints as text. Any angle brackets in it
 * stay angle brackets — see the card, which puts this in a text node and never
 * near `dangerouslySetInnerHTML`.
 */
export function plainText(body: string, limit: number = MAX_NOTES_CHARS): string | null {
  const flattened = body
    .replace(/\r\n?/g, '\n')
    // Every control character except tab and newline — an escape sequence in a
    // release body is not notes, whatever else it may be. Spelled as "in the
    // Cc category and not one of those two" rather than as ranges, because a
    // range of control characters is a regex nobody can read and a linter is
    // right to be suspicious of.
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim()
  if (flattened === '') return null
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit).trimEnd()}…`
}

function epoch(published: string | null | undefined): number | null {
  if (published === null || published === undefined) return null
  const at = Date.parse(published)
  return Number.isFinite(at) ? at : null
}
