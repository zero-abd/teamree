// Where the window is allowed to go. `webPreferences` belongs to the web
// contents, not the document, so a navigation carries the preload bridge — the
// whole runtime — onto whatever lands (measured in `scripts/smoke.mjs`). A
// pane's links come through `window.open` so there is one decision, not two.
// `location.reload()` raises `will-navigate` with the current URL and must stay allowed.

/** `allow` is a reload; `external` is a web address for the browser; `block` is everything else, `file:` included. */
export type NavigationVerdict = 'allow' | 'external' | 'block'

/** Whether the window may follow one navigation; `from` is the dev server or the packaged `index.html`. */
export function navigationVerdict(from: string, to: string): NavigationVerdict {
  const target = parse(to)
  if (target === null) return 'block'
  const current = parse(from)
  if (current !== null && sameDocument(current, target)) return 'allow'
  return target.protocol === 'https:' || target.protocol === 'http:' ? 'external' : 'block'
}

/** The one gate in front of `shell.openExternal`, which macOS will open far more than web pages through. */
export function mayOpenExternally(url: string): boolean {
  const parsed = parse(url)
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
}

/**
 * The answer to a `window.open`: a web address goes to the browser, anything
 * else is refused, and no window is ever opened — a second `BrowserWindow`
 * would carry the preload bridge.
 */
export function windowOpenAnswer(url: string, openExternally: (url: string) => void): { action: 'deny' } {
  if (mayOpenExternally(url)) openExternally(url)
  return { action: 'deny' }
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Two URLs that name the same document. Not by `origin`: every `file:` URL's is `"null"`. */
function sameDocument(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
}
