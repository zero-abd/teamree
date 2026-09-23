// The one way anything in this window reaches the user's browser.
//
// `window.open` and deliberately not a preload channel of its own. Whether a
// URL is something this machine hands to the OS is already decided, once, in
// `src/main/windowNavigation.ts`, and that decision is reached through the
// window-open handler — which sees this call, opens the address beside the app,
// and denies the window. A channel would have been a second answer to the same
// question in a second file, and the bridge is an enumeration worth keeping
// short (`docs/renderer-boundary.md`).
//
// So there is no scheme check here. Not an omission: a check on this side would
// be that second answer, quietly disagreeing with the real one the first time
// either moved.
//
// It lives in its own file because it has more than one caller now — a URL an
// agent printed in a pane, and the review page a push just made available — and
// the whole point of it is that there is one of it.

export function openInBrowser(url: string): void {
  window.open(url, '_blank', 'noopener')
}
