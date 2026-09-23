import { describe, expect, it } from 'vitest'
import {
  changesOnScreen,
  clampRightPanelWidth,
  readStoredRightPanel,
  readStoredRightPanelWidth,
  RIGHT_PANEL_DEFAULT_PX,
  RIGHT_PANEL_MAX_PX,
  RIGHT_PANEL_MIN_PX,
  writeStoredRightPanel,
  writeStoredRightPanelWidth
} from './rightPanelState'

const fakeStorage = (initial: Record<string, string> = {}) => {
  const values = { ...initial }
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, next: string) => {
      values[key] = next
    },
    read: () => values
  }
}

describe('clampRightPanelWidth', () => {
  it('keeps a sensible width and refuses the rest', () => {
    expect(clampRightPanelWidth(360)).toBe(360)
    expect(clampRightPanelWidth(10)).toBe(RIGHT_PANEL_MIN_PX)
    expect(clampRightPanelWidth(9000)).toBe(RIGHT_PANEL_MAX_PX)
    expect(clampRightPanelWidth(360.4)).toBe(360)
    expect(clampRightPanelWidth(Number.NaN)).toBe(RIGHT_PANEL_DEFAULT_PX)
  })
})

describe('the remembered width', () => {
  it('falls back to the default with nothing stored, and clamps what it reads', () => {
    expect(readStoredRightPanelWidth(fakeStorage())).toBe(RIGHT_PANEL_DEFAULT_PX)
    expect(readStoredRightPanelWidth(undefined)).toBe(RIGHT_PANEL_DEFAULT_PX)
    expect(readStoredRightPanelWidth(fakeStorage({ 'teamree.shell.rightPanelWidth': '9999' }))).toBe(RIGHT_PANEL_MAX_PX)
    expect(readStoredRightPanelWidth(fakeStorage({ 'teamree.shell.rightPanelWidth': 'wide' }))).toBe(
      RIGHT_PANEL_DEFAULT_PX
    )
  })

  it('stores the clamped value and survives a storage that throws', () => {
    const storage = fakeStorage()
    writeStoredRightPanelWidth(storage, 9999)
    expect(readStoredRightPanelWidth(storage)).toBe(RIGHT_PANEL_MAX_PX)

    const hostile = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(readStoredRightPanelWidth(hostile)).toBe(RIGHT_PANEL_DEFAULT_PX)
    expect(() => writeStoredRightPanelWidth(hostile, 300)).not.toThrow()
  })
})

describe('the remembered panel', () => {
  // Closed on the files tab is what a fresh machine gets: the panel costs a
  // `git status` per refresh while it is open, and nobody has asked for it yet.
  it('starts closed with nothing stored', () => {
    expect(readStoredRightPanel(fakeStorage())).toEqual({ open: false, tab: 'files' })
    expect(readStoredRightPanel(undefined)).toEqual({ open: false, tab: 'files' })
  })

  it('comes back exactly as it was written', () => {
    const storage = fakeStorage()
    writeStoredRightPanel(storage, { open: true, tab: 'panes' })
    expect(readStoredRightPanel(storage)).toEqual({ open: true, tab: 'panes' })
    writeStoredRightPanel(storage, { open: false, tab: 'changes' })
    expect(readStoredRightPanel(storage)).toEqual({ open: false, tab: 'changes' })
  })

  it('ignores a record it cannot read, field by field', () => {
    expect(readStoredRightPanel(fakeStorage({ 'teamree.shell.rightPanel': 'not json' }))).toEqual({
      open: false,
      tab: 'files'
    })
    expect(readStoredRightPanel(fakeStorage({ 'teamree.shell.rightPanel': '{"open":true,"tab":"nope"}' }))).toEqual({
      open: true,
      tab: 'files'
    })
    expect(readStoredRightPanel(fakeStorage({ 'teamree.shell.rightPanel': '{"open":"yes","tab":"changes"}' }))).toEqual(
      {
        open: false,
        tab: 'changes'
      }
    )
  })
})

describe('changesOnScreen', () => {
  // The refresh that reads `git status` on every event is paid only while
  // somebody could see the answer: the changes tab draws the list, the files
  // tab draws a letter per changed file, and the panes tab draws neither.
  it('is true for the two tabs that draw changes, and only while open', () => {
    expect(changesOnScreen({ rightPanelOpen: true, rightPanelTab: 'changes' })).toBe(true)
    expect(changesOnScreen({ rightPanelOpen: true, rightPanelTab: 'files' })).toBe(true)
    expect(changesOnScreen({ rightPanelOpen: true, rightPanelTab: 'panes' })).toBe(false)
    expect(changesOnScreen({ rightPanelOpen: false, rightPanelTab: 'changes' })).toBe(false)
  })
})
