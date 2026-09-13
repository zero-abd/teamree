// What counts as a relay URL, as a pure grammar.
//
// It lives in `shared` rather than beside the file it is read out of because
// two sides need the same answer. The runtime refuses a URL it cannot dial, and
// the window has to say so *while somebody is typing* — a field that accepts
// everything and reports the refusal after a round trip teaches people that the
// app is flaky rather than that the address is wrong. One copy of the grammar
// means the two can never disagree about which addresses are relays.
//
// Reading it from a file, writing it back and finding the environment override
// are all in `src/main/teamwork/peer/relayUrl.ts`, which is where the disk is.

/**
 * Where the relay serves its only upgradable path, as `relay/README.md` ships
 * it. Used to *suggest* and never to dial: `RELAY_PATH` is configurable, so a
 * URL built from this is a guess to put in front of somebody, not one teamree
 * may act on by itself.
 */
export const RELAY_ENDPOINT_PATH = '/v1/relay'

export type RelayUrlParse =
  | { ok: true; url: string }
  /** `suggestion` is set only when the input is recognisably a relay's base URL. */
  | { ok: false; reason: string; suggestion?: string }

/**
 * Refuses everything that is not a WebSocket URL, including the `https://` a
 * person will paste out of their browser. Guessing `wss://` from it would work
 * often enough to be trusted and fail on the one deployment where the relay is
 * not at the root.
 *
 * Refusing is not the same as being unhelpful, though: the address a deploy
 * prints is the one input everybody arrives with, and a refusal that names the
 * scheme and stops leaves the remedy in a README this person is not reading.
 * So the corrected URL is offered, as a thing to check and paste rather than a
 * thing this function quietly substitutes.
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
  // The rendezvous id is appended to this, so a trailing slash here would make
  // the path the relay sees have an empty segment in the middle of it.
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}

/**
 * The same address, said the way a relay is dialled — or undefined when the
 * input is nothing like one and a suggestion would be noise.
 *
 * `https://host` is what deploying prints, and the endpoint is that host with
 * the relay's path on it; `https://host/somewhere` has already been given a
 * path by somebody, so only the scheme is corrected. A query or a fragment
 * means this is not an address anybody copied out of a deploy, so it gets no
 * guess at all.
 */
export function websocketFormOf(url: URL): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.search || url.hash) return undefined
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = url.pathname.replace(/\/+$/, '')
  return `${scheme}//${url.host}${path || RELAY_ENDPOINT_PATH}`
}
