// The record the window leaves for the next one, and every way it can be wrong.
//
// It is read at startup from storage nothing else validates, so anything that
// is not what this wrote has to end as "no record" rather than as a window that
// cannot be opened.

import { describe, expect, it } from 'vitest'
import { emptySession, readStoredSession, sessionChanged, writeStoredSession } from './storedSession'

const KEY = 'teamree.workspace.session'

function storageWith(raw?: string): Pick<Storage, 'getItem' | 'setItem'> & { written: Record<string, string> } {
  const written: Record<string, string> = {}
  return {
    written,
    getItem: (key) => (key === KEY && raw !== undefined ? raw : null),
    setItem: (key, value) => {
      written[key] = value
    }
  }
}

/** Storage that throws on both halves, as a private window's can. */
const refusingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('the user denied access to storage')
  },
  setItem: () => {
    throw new Error('the user denied access to storage')
  }
}

describe('reading', () => {
  it('reads back what was written', () => {
    const storage = storageWith()
    const session = {
      openWorktreeIds: ['wt_1', 'wt_2'],
      activeWorktreeId: 'wt_2',
      collapsedProjects: { p_1: true, p_2: false },
      sidebarVisible: false
    }
    writeStoredSession(storage, session)

    expect(readStoredSession(storageWith(storage.written[KEY]))).toEqual({
      ...session,
      // An expanded project is the default, so only the folded ones are kept.
      collapsedProjects: { p_1: true }
    })
  })

  it('has nothing to say when nothing was written', () => {
    expect(readStoredSession(storageWith())).toEqual(emptySession())
    expect(readStoredSession(undefined)).toEqual(emptySession())
  })

  it('ignores a record that is not what it wrote', () => {
    expect(readStoredSession(storageWith('not json at all'))).toEqual(emptySession())
    expect(readStoredSession(storageWith('null'))).toEqual(emptySession())
    expect(readStoredSession(storageWith('"a string"'))).toEqual(emptySession())
    expect(readStoredSession(storageWith('[1,2,3]'))).toEqual(emptySession())
    expect(readStoredSession(storageWith('{"openWorktreeIds":"wt_1"}'))).toEqual(emptySession())
    expect(readStoredSession(storageWith('{"collapsedProjects":["p_1"]}'))).toEqual(emptySession())
  })

  it('keeps the parts of a half-broken record that are still readable', () => {
    const session = readStoredSession(
      storageWith(JSON.stringify({ openWorktreeIds: ['wt_1', 7, '', 'wt_1', 'wt_2'], activeWorktreeId: 12 }))
    )
    // Deduplicated, because two tabs on one worktree is not a window either.
    expect(session.openWorktreeIds).toEqual(['wt_1', 'wt_2'])
    expect(session.activeWorktreeId).toBeNull()
  })

  it('drops an active worktree that has no tab', () => {
    const session = readStoredSession(
      storageWith(JSON.stringify({ openWorktreeIds: ['wt_1'], activeWorktreeId: 'wt_9' }))
    )
    expect(session.openWorktreeIds).toEqual(['wt_1'])
    expect(session.activeWorktreeId).toBeNull()
  })

  it('opens a window when storage itself refuses', () => {
    expect(readStoredSession(refusingStorage)).toEqual(emptySession())
  })
})

describe('writing', () => {
  it('survives storage that refuses', () => {
    expect(() => writeStoredSession(refusingStorage, emptySession())).not.toThrow()
    expect(() => writeStoredSession(undefined, emptySession())).not.toThrow()
  })

  it('caps a list no window could have had', () => {
    const storage = storageWith()
    const many = Array.from({ length: 500 }, (_, index) => `wt_${index}`)
    writeStoredSession(storage, { ...emptySession(), openWorktreeIds: many })

    expect(readStoredSession(storageWith(storage.written[KEY])).openWorktreeIds).toHaveLength(64)
  })
})

describe('what counts as a change', () => {
  const base = { ...emptySession(), openWorktreeIds: ['wt_1', 'wt_2'], activeWorktreeId: 'wt_1' }

  it('sees the tabs, their order, the front one, and the sidebar', () => {
    expect(sessionChanged(base, { ...base })).toBe(false)
    expect(sessionChanged(base, { ...base, openWorktreeIds: ['wt_2', 'wt_1'] })).toBe(true)
    expect(sessionChanged(base, { ...base, activeWorktreeId: 'wt_2' })).toBe(true)
    expect(sessionChanged(base, { ...base, sidebarVisible: false })).toBe(true)
    expect(sessionChanged(base, { ...base, collapsedProjects: { p_1: true } })).toBe(true)
  })

  it('does not see a project being expanded back to the default', () => {
    expect(sessionChanged(base, { ...base, collapsedProjects: { p_1: false } })).toBe(false)
  })
})
