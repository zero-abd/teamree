import { describe, expect, it } from 'vitest'
import type { BaseFetchState } from '@shared/entities'
import { baseFreshness, startPointAge, STALE_AFTER_MS } from './baseFreshness'

const now = 10 * 60 * 60_000
const project = (fetch?: BaseFetchState) => ({ baseRef: 'origin/main', ...(fetch ? { fetch } : {}) })

describe('baseFreshness', () => {
  it('says nothing about a fetch under an hour old, or one never tried', () => {
    expect(baseFreshness(project(), now)).toBeNull()
    expect(baseFreshness(project({ fetchedAt: now - 59 * 60_000 }), now)).toBeNull()
  })

  it('says how old the base is from an hour on', () => {
    expect(baseFreshness(project({ fetchedAt: now - STALE_AFTER_MS }), now)).toBe('fetched 1h ago')
    expect(baseFreshness(project({ fetchedAt: now - 3 * 60 * 60_000 - 5 }), now)).toBe('fetched 3h ago')
  })

  it('names why the last fetch failed, however recent the one before it', () => {
    const at = now - 60_000
    expect(baseFreshness(project({ fetchedAt: at, failure: 'offline' }), now)).toBe("can't reach origin")
    expect(baseFreshness(project({ failure: 'auth', retryAt: now + 1 }), now)).toBe('sign-in failed')
    expect(baseFreshness(project({ failure: 'not-found' }), now)).toBe('origin/main not found')
    expect(baseFreshness(project({ failure: 'timeout' }), now)).toBe('fetch timed out')
    expect(baseFreshness(project({ failure: 'failed' }), now)).toBe('fetch failed')
  })
})

describe('startPointAge', () => {
  it('dates the fetch when it is old or failed, and says why when no date is known', () => {
    expect(startPointAge(project({ fetchedAt: now - 60_000 }), now)).toBeNull()
    expect(startPointAge(project({ fetchedAt: now - 3 * 60 * 60_000 }), now)).toBe('fetched 3h ago')
    expect(startPointAge(project({ fetchedAt: now - 20 * 60_000, failure: 'offline' }), now)).toBe('fetched 20m ago')
    expect(startPointAge(project({ failure: 'auth' }), now)).toBe('sign-in failed')
  })
})
