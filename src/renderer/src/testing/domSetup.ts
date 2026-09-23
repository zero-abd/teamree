// The DOM half of the test harness: a setup file for every test, inert unless there is a window
// (renderer tests opt into jsdom per file). Stubs, not emulations, for browser APIs jsdom lacks.

import { afterEach } from 'vitest'

if (typeof window !== 'undefined') {
  // RTL only auto-unmounts with a global `afterEach`, and the suite does not run with `globals: true`.
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)

  if (typeof globalThis.ResizeObserver !== 'function') {
    // jsdom never resizes; views that must react call the callback themselves.
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
    // jsdom has no `CSS` namespace; every real target has `CSS.escape`.
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
