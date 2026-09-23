import { describe, expect, it } from 'vitest'
import { optOutOfStateRestoration } from './stateRestoration'

function fakePreferences(): {
  registered: Record<string, unknown>[]
  registerDefaults: (d: Record<string, unknown>) => void
} {
  const registered: Record<string, unknown>[] = []
  return { registered, registerDefaults: (defaults) => registered.push(defaults) }
}

describe('optOutOfStateRestoration', () => {
  it("turns AppKit's window restoration off on macOS", () => {
    const preferences = fakePreferences()
    optOutOfStateRestoration('darwin', preferences)
    expect(preferences.registered).toEqual([{ ApplePersistence: false }])
  })

  it('does nothing elsewhere', () => {
    const preferences = fakePreferences()
    optOutOfStateRestoration('linux', preferences)
    optOutOfStateRestoration('win32', preferences)
    expect(preferences.registered).toEqual([])
  })
})
