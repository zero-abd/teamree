// The DOM half of the test harness, loaded for every test file and inert in
// most of them.
//
// The suite is overwhelmingly pure logic and a DOM costs it nothing but time,
// so `environment` stays `node` and a renderer test opts in per file with
// `@vitest-environment jsdom`. This file is the other half of that bargain: it
// is a setup file, so it runs for all of them, and everything it does is behind
// a check for a window. Under node it imports nothing and registers nothing.
//
// What it installs is the short list of browser APIs jsdom does not implement
// that this renderer actually calls. They are stubs rather than emulations —
// jsdom has no layout, so there is no size for a ResizeObserver to report and
// no box for `scrollIntoView` to scroll to — and a test that needs a real
// measurement stubs the measurement itself rather than asking for one here.

import { afterEach } from 'vitest'

if (typeof window !== 'undefined') {
  // React Testing Library only unmounts by itself when a global `afterEach`
  // exists. The suite does not run with `globals: true`, so it is wired here —
  // once, rather than in the footer of every renderer test.
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)

  if (typeof globalThis.ResizeObserver !== 'function') {
    // Observed elements never change size in jsdom, so the callback would never
    // fire anyway. Views that must react to a resize call the observer's
    // callback themselves through this stub.
    class StubResizeObserver implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = StubResizeObserver
  }

  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {}
  }

  if (typeof globalThis.CSS?.escape !== 'function') {
    // jsdom ships no `CSS` namespace at all. Every browser this app runs in
    // has had `CSS.escape` for a decade, so the gap is the harness's, not the
    // renderer's — and a component that used it would otherwise throw here for
    // a reason that says nothing about the component.
    const escape = (value: string): string => String(value).replace(/[^\w-]/g, (char) => `\\${char}`)
    globalThis.CSS = { ...globalThis.CSS, escape } as typeof globalThis.CSS
  }

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
  }
}
