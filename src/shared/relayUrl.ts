// What counts as a relay URL, as a pure grammar shared by the runtime (which
// refuses) and the window (which says so while typing). Disk access is in
// `src/main/teamwork/peer/relayUrl.ts`.

/**
 * The relay's only upgradable path as `relay/README.md` ships it. Used to suggest,
 * never to dial: `RELAY_PATH` is configurable, so a URL built from this is a guess.
 */
export const RELAY_ENDPOINT_PATH = '/v1/relay'

export type RelayUrlParse =
  | { ok: true; url: string }
  /** `suggestion` is set only when the input is recognisably a relay's base URL. */
  | { ok: false; reason: string; suggestion?: string }

/**
 * Refuses everything that is not a WebSocket URL, including a pasted `https://`:
 * guessing `wss://` would fail on the one deploy not at the root. The corrected URL is offered, not substituted.
 */
export function parseRelayUrl(raw: string): RelayUrlParse {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'it is empty' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'it is not a URL' }
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    const reason = `the scheme is "${url.protocol.replace(':', '')}", not ws or wss`
    const suggestion = websocketFormOf(url)
    if (suggestion === undefined) return { ok: false, reason }
    return { ok: false, reason: `${reason}. A deployed relay is reached at ${suggestion}`, suggestion }
  }
  if (url.search || url.hash) return { ok: false, reason: 'a relay URL carries no query or fragment' }
  // The rendezvous id is appended, so a trailing slash would leave an empty segment mid-path.
  const path = url.pathname.replace(/\/+$/, '')
  // An origin with no path (scheme corrected, endpoint not added) can be dialled by
  // no relay configuration: the relay would see `/<rendezvous>`, fail the upgrade,
  // and send two people to debug a healthy deploy. Refused rather than corrected.
  if (path === '') {
    const suggestion = `${url.origin}${RELAY_ENDPOINT_PATH}`
    return {
      ok: false,
      reason: `it has no path, and a relay is served under one. A deployed relay is reached at ${suggestion}`,
      suggestion
    }
  }
  return { ok: true, url: `${url.origin}${path}` }
}

/**
 * The same address as a relay is dialled, or undefined when a suggestion would be
 * noise. A bare host gets the relay path; an existing path only has its scheme corrected.
 */
export function websocketFormOf(url: URL): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.search || url.hash) return undefined
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = url.pathname.replace(/\/+$/, '')
  return `${scheme}//${url.host}${path || RELAY_ENDPOINT_PATH}`
}
