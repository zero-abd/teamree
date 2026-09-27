// The sidebar's view (field, chips, Compact, unfolded done rows) is this window's, kept across a relaunch.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  readStoredSidebarView,
  useSidebarView,
  writeStoredSidebarView,
  type StoredSidebarView
} from './sidebarViewStore'

const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
}

const INITIAL = useSidebarView.getState()

beforeEach(() => {
  useSidebarView.setState(INITIAL, true)
})

describe('the stored view', () => {
  it('reads back what was written', () => {
    const storage = memory()
    const view: StoredSidebarView = {
      query: 'cart',
      quick: ['working', 'hide-done'],
      compact: true,
      openDone: ['p1']
    }
    writeStoredSidebarView(storage, view)
    expect(readStoredSidebarView(storage)).toEqual(view)
  })

  it('starts empty, and drops what it cannot read', () => {
    expect(readStoredSidebarView(memory())).toEqual({ query: '', quick: [], compact: false, openDone: [] })
    const storage = memory()
    storage.setItem('teamree.sidebar.view', JSON.stringify({ query: 3, quick: ['working', 'bogus'], compact: 'yes' }))
    expect(readStoredSidebarView(storage)).toEqual({ query: '', quick: ['working'], compact: false, openDone: [] })
    storage.setItem('teamree.sidebar.view', '{nope')
    expect(readStoredSidebarView(storage).quick).toEqual([])
  })
})

describe('the view store', () => {
  it('toggles a chip, Compact, and one project’s done rows', () => {
    const view = (): ReturnType<typeof useSidebarView.getState> => useSidebarView.getState()
    view().toggleQuick('needs-you')
    view().toggleQuick('hide-done')
    view().toggleQuick('needs-you')
    expect(view().quick).toEqual(['hide-done'])
    view().setCompact(true)
    expect(view().compact).toBe(true)
    view().toggleDone('p1')
    expect(view().openDone).toEqual(['p1'])
    view().toggleDone('p1')
    expect(view().openDone).toEqual([])
  })

  it('counts reveals, so the same one twice is still news', () => {
    const before = useSidebarView.getState().revealSeq
    useSidebarView.getState().reveal('w1')
    useSidebarView.getState().reveal('w1')
    expect(useSidebarView.getState().revealSeq).toBe(before + 2)
  })

  it('keeps the picked row past the filter until the filter changes', () => {
    const view = useSidebarView.getState
    view().reveal('w1')
    expect(view().picked).toBe('w1')
    view().setQuery('x')
    expect(view().picked).toBeNull()
    view().reveal('w2')
    view().toggleQuick('working')
    expect(view().picked).toBeNull()
    view().reveal('w3')
    view().closeFilter()
    expect(view().picked).toBeNull()
  })

  it('holds a filter request until the field takes it', () => {
    useSidebarView.getState().askFilter()
    expect(useSidebarView.getState().filterAsked).toBe(true)
    useSidebarView.getState().filterTaken()
    expect(useSidebarView.getState().filterAsked).toBe(false)
  })
})
