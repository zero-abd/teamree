// Where a page goes to become a Claude artifact, and how a link to one is recognised.

/** `Open as artifact` copies the page and opens a new chat here to paste it into. */
export const NEW_CHAT_URL = 'https://claude.ai/new'

/** A page on claude.ai with a path: an artifact, or something beside one. */
export function isArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'claude.ai' && parsed.pathname.length > 1
  } catch {
    return false
  }
}

/** The card's title until we know better: the URL's last path segment. */
export function artifactTitle(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0)
    return decodeURIComponent(segments[segments.length - 1] ?? '') || url
  } catch {
    return url
  }
}
