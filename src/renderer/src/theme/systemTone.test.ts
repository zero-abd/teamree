/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSystemTone, watchSystemTone } from './systemTone'

type Listener = (event: { matches: boolean }) => void

function fakeScheme(dark: boolean): { flip: (dark: boolean) => void } {
  const listeners = new Set<Listener>()
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener)
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    flip: (next) => {
      query.matches = next
      for (const listener of listeners) listener({ matches: next })
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the system tone', () => {
  it('is dark where there is no media query to ask', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(readSystemTone()).toBe('dark')
  })

  it('reads the scheme', () => {
    fakeScheme(false)
    expect(readSystemTone()).toBe('light')
  })

  it('reports each switch until stopped', () => {
    const scheme = fakeScheme(true)
    const seen: string[] = []
    const stop = watchSystemTone((tone) => seen.push(tone))
    scheme.flip(false)
    scheme.flip(true)
    stop()
    scheme.flip(false)
    expect(seen).toEqual(['light', 'dark'])
  })
})
