import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  readStoredSidebarWidth,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  writeStoredSidebarWidth
} from './sidebarWidth'

describe('clampSidebarWidth', () => {
  it('keeps a sensible width as it is', () => {
    expect(clampSidebarWidth(300)).toBe(300)
  })

  it('refuses to squeeze or stretch past the bounds', () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_PX)
  })

  it('rounds to whole pixels and survives nonsense', () => {
    expect(clampSidebarWidth(300.6)).toBe(301)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_PX)
  })
})

describe('stored width', () => {
  const fakeStorage = (initial: string | null) => {
    let value = initial
    return {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
      read: () => value
    }
  }

  it('falls back to the default when nothing is stored', () => {
    expect(readStoredSidebarWidth(fakeStorage(null))).toBe(SIDEBAR_DEFAULT_PX)
    expect(readStoredSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_PX)
  })

  it('clamps whatever it reads back', () => {
    expect(readStoredSidebarWidth(fakeStorage('9999'))).toBe(SIDEBAR_MAX_PX)
    expect(readStoredSidebarWidth(fakeStorage('not a number'))).toBe(SIDEBAR_DEFAULT_PX)
  })

  it('stores the clamped value, not the raw one', () => {
    const storage = fakeStorage(null)
    writeStoredSidebarWidth(storage, 9999)
    expect(storage.read()).toBe(String(SIDEBAR_MAX_PX))
  })

  it('survives a storage that throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(readStoredSidebarWidth(hostile)).toBe(SIDEBAR_DEFAULT_PX)
    expect(() => writeStoredSidebarWidth(hostile, 300)).not.toThrow()
  })
})
