// The rule that keeps the preload bridge on the page it was built for. Refuse
// too much and the window cannot reload; refuse too little — an `origin`
// comparison — and every `file:` URL matches, their origin being `"null"`.

import { describe, expect, it } from 'vitest'
import { mayOpenExternally, navigationVerdict, windowOpenAnswer } from './windowNavigation'

const PACKAGED = 'file:///Applications/teamree.app/Contents/Resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

describe('where the window may go', () => {
  // `location.reload()` raises `will-navigate` with the URL already loaded.
  it('lets the window reload the page it is already on', () => {
    expect(navigationVerdict(PACKAGED, PACKAGED)).toBe('allow')
    expect(navigationVerdict(DEV, DEV)).toBe('allow')
  })

  // A navigated-to document keeps the preload bridge and brings no CSP of its own.
  it('refuses another file on the disk, however much it looks like ours', () => {
    expect(navigationVerdict(PACKAGED, 'file:///Users/ada/Downloads/invoice.html')).toBe('block')
    // Both of these have the origin `"null"`.
    expect(navigationVerdict(PACKAGED, 'file:///tmp/index.html')).toBe('block')
  })

  it('refuses the schemes that are not pages at all', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'about:blank', 'not a url']) {
      expect(navigationVerdict(PACKAGED, url), url).toBe('block')
    }
  })

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
  // `shell.openExternal` opens far more than web pages.
  it('is a web address and nothing else', () => {
    expect(mayOpenExternally('https://github.com/zero-abd/teamree')).toBe(true)
    expect(mayOpenExternally('http://localhost:5173/')).toBe(true)
    for (const url of ['about:blank', 'file:///etc/hosts', 'javascript:alert(1)', 'x-apple-script://run', '']) {
      expect(mayOpenExternally(url), url).toBe(false)
    }
  })
})

describe('what a window.open from the page means', () => {
  // The URL is all the handler sees. A pane's links arrive here too, on purpose:
  // one decision about what gets handed to the OS.
  it('sends a link to the browser, and still opens no window', () => {
    const opened: string[] = []
    const answer = windowOpenAnswer('https://github.com/zero-abd/teamree/pull/7', (url) => opened.push(url))

    expect(opened).toEqual(['https://github.com/zero-abd/teamree/pull/7'])
    // Never `allow`: a second window would carry the preload bridge.
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
