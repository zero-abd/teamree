// The one column of `worktree list` that is computed rather than copied: a
// checkout deleted from disk keeps a `ready` record, and a listing that printed
// that word over a path that is not there would be the CLI repeating the
// sidebar's old mistake.

import { describe, expect, it } from 'vitest'
import { shownState } from './worktree.js'

describe('the state column', () => {
  it('prints the record’s state while the checkout is where it says', () => {
    expect(shownState({ state: 'ready' })).toBe('ready')
    expect(shownState({ state: 'creating' })).toBe('creating')
  })

  it('says missing over a ready record whose directory has gone', () => {
    expect(shownState({ state: 'ready', missing: true })).toBe('missing')
  })
})
