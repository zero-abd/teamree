// Asking GitHub what the newest published release is. The response is a trust
// boundary: the notes are shown and the download URL goes to the browser, so
// tag, URL, notes and body length are all checked. The releases API is the
// only source that says which release is a pre-release.

import { z } from 'zod'
import { compareVersions, isPrereleaseVersion, parseVersion, type Version } from './semver'

/** Where the releases are. `owner/name`, as gh spells it. */
export const UPDATE_REPOSITORY = 'zero-abd/teamree'

export const GITHUB_API_ORIGIN = 'https://api.github.com'

/** The only host a download link is allowed to lead to. */
export const RELEASE_HOST = 'github.com'

/** A captive portal accepts the connection and says nothing; without this the request outlives the user. */
export const REQUEST_TIMEOUT_MS = 10_000

/** The most of a response body that will be read; a release is a few kilobytes. */
export const MAX_RESPONSE_BYTES = 256 * 1024

/** The most release notes that are shown. Past it the reader gets the link. */
export const MAX_NOTES_CHARS = 4_000

/** Releases looked at when picking the newest on the pre-release channel. */
export const PRERELEASE_PAGE_SIZE = 20

/**
 * Which releases this build is a candidate for. `stable` asks `/releases/latest`,
 * GitHub's newest non-draft non-prerelease, and checks that again here.
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
  /** The `.dmg` with what GitHub says its size and SHA-256 are; null when either is missing. */
  installer: DiskImage | null
  /** The release's own page, built from the tag rather than taken from the API. */
  releaseUrl: string
  /** Epoch milliseconds, or null when the date was missing or unreadable. */
  publishedAt: number | null
}

/** A release's disk image, with what a download of it has to match. */
export type DiskImage = {
  url: string
  /** A plain file name: it becomes the name in ~/Downloads. */
  name: string
  size: number
  /** Lowercase hex. */
  sha256: string
}

/**
 * Exactly the fields that are used, every one optional: demanding the whole
 * shape would make an API rename a check that fails silently on every machine.
 */
const ReleaseSchema = z.object({
  tag_name: z.string().optional(),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullish(),
  assets: z
    .array(
      z
        .object({
          name: z.string().optional(),
          browser_download_url: z.string().optional(),
          size: z.number().optional(),
          digest: z.string().nullish()
        })
        .passthrough()
    )
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
 * Throws when the check could not be made; the message is for the log, not a window.
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
      // Pinned, so the shape changes on this project's schedule rather than GitHub's.
      'x-github-api-version': '2022-11-28',
      // GitHub refuses a request without one.
      'user-agent': `teamree/${options.version}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!response.ok) {
    // 403 is the rate limit, 404 a repository with no releases yet; neither goes in front of the user.
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
 * One release, if it is one this app can act on: not a draft, a tag that is a
 * version, and on the stable channel not a pre-release whatever endpoint it came from.
 */
function usable(raw: RawRelease, repository: string, channel: ReleaseChannel): LatestRelease | null {
  if (raw.draft === true) return null
  const prerelease = raw.prerelease === true
  if (channel === 'stable' && prerelease) return null

  const tag = raw.tag_name?.trim() ?? ''
  const version = parseVersion(tag)
  // The tag is a path segment in the URLs below: this keeps `../` and a query string out.
  if (version === null || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) return null

  return {
    version: version.raw,
    tag,
    // GitHub's flag or the tag's shape: `v0.3.0-rc.1` is a candidate whether or not the box was ticked.
    prerelease: prerelease || isPrereleaseVersion(version),
    notes: plainText(raw.body ?? ''),
    downloadUrl: diskImage(raw, repository),
    installer: verifiableImage(raw, repository),
    // Built from a checked tag rather than read from `html_url`.
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

/** The macOS image among the release's assets, or null. This URL goes to the browser, so it is checked. */
function diskImage(raw: RawRelease, repository: string): string | null {
  for (const asset of raw.assets ?? []) {
    if (asset.name === undefined || !asset.name.endsWith('.dmg')) continue
    const url = asset.browser_download_url
    if (url === undefined) continue
    if (isReleaseDownload(url, repository)) return url
  }
  return null
}

/** The first `.dmg` GitHub gives a size and SHA-256 for, under a name safe to save as. */
function verifiableImage(raw: RawRelease, repository: string): DiskImage | null {
  for (const asset of raw.assets ?? []) {
    const { name, browser_download_url: url, size, digest } = asset
    if (name === undefined || url === undefined || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.dmg$/.test(name)) continue
    if (!isReleaseDownload(url, repository)) continue
    const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? '')?.[1]?.toLowerCase()
    if (sha256 === undefined || size === undefined || !Number.isSafeInteger(size) || size <= 0) continue
    return { url, name, size, sha256 }
  }
  return null
}

/**
 * Whether a URL is an address in this repository's releases, served over TLS.
 * Parsed, not prefix-matched: `https://github.com.example.invalid/` passes a string compare.
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
 * The response body, up to the budget, abandoned past it. Streamed, because
 * `response.text()` has buffered the whole thing before its length can be checked.
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
 * Release notes as something safe to put on screen: markdown carries HTML, so
 * nothing renders it; control characters are dropped and the card uses a text node.
 */
export function plainText(body: string, limit: number = MAX_NOTES_CHARS): string | null {
  const flattened = body
    .replace(/\r\n?/g, '\n')
    // Every control character except tab and newline; spelled by category, not ranges.
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
