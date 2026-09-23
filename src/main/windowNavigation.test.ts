// The rule that keeps the preload bridge on the page it was built for.
//
// What makes this worth a test rather than four lines in `index.ts` is that
// both of its branches are easy to get wrong in opposite directions. Refuse too
// much and the window cannot reload itself, which is what the dev server does
// on a change it cannot hot-patch. Refuse too little — an `origin` comparison,
// say — and every file on the disk is the app's own page, because a `file:`
// URL's origin is the string `"null"` and two of them always match.
//
// `scripts/smoke.mjs` is the other half: this states the rule, and that one
// watches a real window refuse a real navigation.

import { describe, expect, it } from 'vitest'
import { mayOpenExternally, navigationVerdict, windowOpenAnswer } from './windowNavigation'

const PACKAGED = 'file:///Applications/teamree.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

describe('where the window may go', () => {
  // `location.reload()` raises `will-navigate` with the URL already loaded —
  // measured in the smoke harness — so this branch is what stops the rule being
  // a refusal to reload the app.
  it('lets the window reload the page it is already on', () => {
    expect(navigationVerdict(PACKAGED, PACKAGED)).toBe('allow')
    expect(navigationVerdict(DEV, DEV)).toBe('allow')
  })

  // The whole point. A navigated-to document keeps the preload bridge and
  // brings no Content-Security-Policy of its own, so it is the app's page with
  // somebody else's HTML in it.
  it('refuses another file on the disk, however much it looks like ours', () => {
    expect(navigationVerdict(PACKAGED, 'file:///Users/ada/Downloads/invoice.html')).toBe('block')
    // The trap an `origin` comparison falls into: both of these have the origin
    // `"null"`, so a check written that way would call this one the app's page.
    expect(navigationVerdict(PACKAGED, 'file:///tmp/index.html')).toBe('block')
  })

  it('refuses the schemes that are not pages at all', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'about:blank', 'not a url']) {
      expect(navigationVerdict(PACKAGED, url), url).toBe('block')
    }
  })

  // The same answer a link with a `target` already gets, so a link behaves the
  // same whether or not it carries one.
  it('sends a web address to the browser instead of following it', () => {
    expect(navigationVerdict(PACKAGED, 'https://github.com/zero-abd/teamree')).toBe('external')
    expect(navigationVerdict(PACKAGED, 'http://example.invalid/')).toBe('external')
  })

  it('does not mistake a different path on the dev server for the page itself', () => {
    expect(navigationVerdict(DEV, 'http://localhost:5173/somewhere-else')).toBe('external')
    expect(navigationVerdict(DEV, 'http://localhost:5174/')).toBe('external')
  })
})

describe('what may be handed to macOS', () => {
  // `shell.openExternal` opens whatever the OS knows how to open, which is a
  // great deal more than a web page.
  it('is a web address and nothing else', () => {
    expect(mayOpenExternally('https://github.com/zero-abd/teamree')).toBe(true)
    expect(mayOpenExternally('http://localhost:5173/')).toBe(true)
    for (const url of ['about:blank', 'file:///etc/hosts', 'javascript:alert(1)', 'x-apple-script://run', '']) {
      expect(mayOpenExternally(url), url).toBe(false)
    }
  })
})

describe('what a window.open from the page means', () => {
  // The handler cannot see who called it, so the URL is the whole of what tells
  // a link somebody clicked from a page somebody is trying to put in front of
  // them. A pane's links arrive here: the web-links addon and xterm's own OSC 8
  // handler both end in `window.open`, which is deliberate — this is the one
  // decision about what gets handed to the OS, and there is no second one in
  // the renderer.
  it('sends a link to the browser, and still opens no window', () => {
    const opened: string[] = []
    const answer = windowOpenAnswer('https://github.com/zero-abd/teamree/pull/7', (url) => opened.push(url))

    expect(opened).toEqual(['https://github.com/zero-abd/teamree/pull/7'])
    // Never `allow`. A second window would carry this one's preload bridge onto
    // whatever landed in it, which is the whole argument of the rule above.
    expect(answer).toEqual({ action: 'deny' })
  })

  it('hands the OS nothing else, whatever asked for it', () => {
    for (const url of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      'about:blank',
      'data:text/html,<script>1</script>'
    ]) {
      const opened: string[] = []
      expect(windowOpenAnswer(url, (target) => opened.push(target))).toEqual({ action: 'deny' })
      expect(opened, url).toEqual([])
    }
  })
})
