// Where the window is allowed to go, and where a link is allowed to take it.
//
// The window is a renderer with a preload bridge on it, and the bridge is the
// whole runtime — every method the `teamree` command can call, which
// `docs/local-access.md` spells out as create a worktree, spawn a pty and type
// into it. A `webPreferences` is a property of the *web contents*, not of the
// document loaded into it, so a navigation does not leave the bridge behind: it
// carries it onto whatever lands. That was measured rather than reasoned about
// — `scripts/smoke.mjs` navigates the real window to a file it wrote and finds
// `window.teamree.runtime.call('status.get')` answering from the new page — and
// it is the reason this module exists. The document that arrives has no
// `Content-Security-Policy` of its own either, because the app's is a `<meta>`
// tag in the app's own HTML and nothing else.
//
// Nothing in today's renderer can start a navigation, and that is not an
// accident anybody arranged: every form calls `preventDefault`, and every
// anchor is a constant carrying `target="_blank"`, which makes it a
// `window.open` rather than a navigation. So this is not a defence against a
// reachable attack today. It is here because the cost of the gap is not
// proportional to how hard it is to reach — one anchor without a `target`, one
// form that forgets its `preventDefault`, one dropped file — and because the
// shape of the failure is total.
//
// A pane's links arrive the same way. A URL an agent printed is clickable now
// (`src/renderer/src/terminal/TerminalView.tsx`), and the renderer opens it with
// `window.open` for one reason: **that is this decision, and there must not be a
// second one.** The alternative was a preload channel of its own, which would
// have meant a second answer to "is this a thing we hand the OS" living in a
// second file — and `docs/renderer-boundary.md` is an enumeration of what the
// bridge grants, which is worth keeping short.
//
// Reloading has to keep working. `location.reload()` raises `will-navigate`
// with the URL the window is already on (measured, same harness), which is what
// the dev server's hot reload does when a full reload is needed, so a blanket
// refusal would be a refusal to reload the app.

/**
 * What to do with a navigation the page asked for.
 *
 * - `allow` — it is the document already loaded, which is a reload.
 * - `external` — it is a web address, and web addresses belong in the user's
 *   browser rather than in this window. The same answer `setWindowOpenHandler`
 *   gives, so a link behaves the same whether or not it carries a `target`.
 * - `block` — anything else, including every `file:` URL but the app's own.
 */
export type NavigationVerdict = 'allow' | 'external' | 'block'

/**
 * Whether the window may follow one navigation, given where it already is.
 *
 * `from` is what the web contents reports as its URL, so in development it is
 * the dev server and in a build it is the packaged `index.html`; neither is
 * hard-coded here, which is what keeps this one rule rather than two.
 */
export function navigationVerdict(from: string, to: string): NavigationVerdict {
  const target = parse(to)
  if (target === null) return 'block'
  const current = parse(from)
  if (current !== null && sameDocument(current, target)) return 'allow'
  return target.protocol === 'https:' || target.protocol === 'http:' ? 'external' : 'block'
}

/**
 * Whether a URL is one this app will hand to the user's browser.
 *
 * `shell.openExternal` asks macOS to open whatever it is given, and macOS will
 * open a great deal more than a web page. This is the one gate in front of it.
 */
export function mayOpenExternally(url: string): boolean {
  const parsed = parse(url)
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
}

/**
 * What a `window.open` from the page means, and the answer the window gives it.
 *
 * Two different things arrive here and they are told apart by the URL alone,
 * which is all Chromium hands over: **a link somebody activated**, which is a
 * web address and belongs in the user's browser, and **an attempt to put some
 * other document in front of a person**, which is everything else and is
 * refused. A pane's links are the first kind — the web-links addon and xterm's
 * own OSC 8 handler both end in `window.open` — and so is the help page's
 * anchor and the update card's.
 *
 * No window is ever opened, in either case. A second `BrowserWindow` would
 * carry this one's preload bridge onto whatever landed in it, which is the
 * whole argument of the navigation rule above; the link is opened *beside* the
 * app rather than inside it.
 *
 * The opener is passed in rather than imported so that this can be stated as a
 * test. `index.ts` supplies `shell.openExternal`.
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

/**
 * Two URLs that name the same document.
 *
 * Compared field by field rather than by `origin`, because a `file:` URL's
 * origin is the string `"null"` — two unrelated files on disk have the same
 * one, and an equality test on it would call every one of them the app's own
 * page.
 */
function sameDocument(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
}
