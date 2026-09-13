// The headless half of the power monitor.
//
// This suite, like the acceptance suite, runs the runtime under plain Node.
// There is no Electron here to ask about sleep, and that has to cost nothing at
// all: no import, no throw, and a link that still notices a sleep by itself.

import { describe, expect, it } from 'vitest'
import { watchForWake } from './wakeWatch'

describe('listening for this machine waking up', () => {
  it('is a no-op outside Electron rather than an import that fails', async () => {
    expect(process.versions.electron).toBeUndefined()

    let woke = 0
    const unwatch = await watchForWake(() => {
      woke += 1
    })

    expect(typeof unwatch).toBe('function')
    expect(woke).toBe(0)
    // Unsubscribing from nothing is still unsubscribing.
    expect(() => unwatch()).not.toThrow()
  })
})
