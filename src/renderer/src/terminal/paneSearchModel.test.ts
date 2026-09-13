import { describe, expect, it } from 'vitest'
import {
  canStep,
  EMPTY_PANE_SEARCH,
  matchLabel,
  paneSearchReducer,
  searchFieldAction,
  SEARCH_HIGHLIGHT_LIMIT,
  toFindOptions,
  type PaneSearchKeyEvent,
  type PaneSearchState
} from './paneSearchModel'

const DECORATIONS = { matchOverviewRuler: '#5c6577', activeMatchColorOverviewRuler: '#a6a7ff' }

const withResults = (query: string, resultIndex: number, resultCount: number): PaneSearchState => {
  const typed = paneSearchReducer(EMPTY_PANE_SEARCH, { type: 'query', value: query })
  return paneSearchReducer(typed, { type: 'results', resultIndex, resultCount })
}

const key = (event: Partial<PaneSearchKeyEvent> & { key: string }): PaneSearchKeyEvent => ({
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...event
})

describe('paneSearchReducer', () => {
  it('starts case-insensitive, which is what a reader skimming output wants', () => {
    expect(EMPTY_PANE_SEARCH.options).toEqual({ caseSensitive: false, wholeWord: false })
  })

  it('keeps the same state object when the query has not actually changed', () => {
    const state = withResults('error', 2, 9)
    expect(paneSearchReducer(state, { type: 'query', value: 'error' })).toBe(state)
  })

  it('drops the tally when the query changes, so no count outlives its term', () => {
    const state = withResults('error', 2, 9)
    const next = paneSearchReducer(state, { type: 'query', value: 'erro' })
    expect(next.current).toBe(0)
    expect(next.total).toBe(0)
    expect(matchLabel(next)).toBe('No results')
  })

  it('drops the tally when an option is toggled, because the result set moves with it', () => {
    const state = withResults('Error', 0, 4)
    const next = paneSearchReducer(state, { type: 'toggle', option: 'caseSensitive' })
    expect(next.options).toEqual({ caseSensitive: true, wholeWord: false })
    expect(next.total).toBe(0)
  })

  it('toggles each option independently and back off again', () => {
    const on = paneSearchReducer(EMPTY_PANE_SEARCH, { type: 'toggle', option: 'wholeWord' })
    expect(on.options).toEqual({ caseSensitive: false, wholeWord: true })
    const off = paneSearchReducer(on, { type: 'toggle', option: 'wholeWord' })
    expect(off.options).toEqual({ caseSensitive: false, wholeWord: false })
  })

  it('leaves the options object identical when only the query moves', () => {
    const state = withResults('a', 0, 1)
    expect(paneSearchReducer(state, { type: 'query', value: 'ab' }).options).toBe(state.options)
  })

  it('turns the addon zero-based index into a human position', () => {
    expect(withResults('x', 0, 3).current).toBe(1)
    expect(withResults('x', 2, 3).current).toBe(3)
  })

  it('reports no position while the addon has counted but selected nothing', () => {
    const state = withResults('x', -1, 12)
    expect(state.current).toBe(0)
    expect(state.total).toBe(12)
  })

  it('never reports a negative total, whatever the addon says', () => {
    expect(withResults('x', -1, -1).total).toBe(0)
  })

  it('keeps the query but forgets the counts on reset, so reopening re-searches', () => {
    const state = withResults('error', 2, 9)
    const next = paneSearchReducer(state, { type: 'reset' })
    expect(next.query).toBe('error')
    expect(next.current).toBe(0)
    expect(next.total).toBe(0)
  })
})

describe('matchLabel', () => {
  it('says nothing at all about an empty field', () => {
    expect(matchLabel(EMPTY_PANE_SEARCH)).toBe('')
  })

  it('reads as a position within a total', () => {
    expect(matchLabel(withResults('error', 2, 17))).toBe('3 of 17')
  })

  it('distinguishes a term that is present from one that is not', () => {
    expect(matchLabel(withResults('nothing', -1, 0))).toBe('No results')
  })

  it('counts without a position when the addon has not picked a match yet', () => {
    expect(matchLabel(withResults('error', -1, 17))).toBe('17 matches')
  })

  it('marks a count that hit the ceiling as a floor, so "more" is visible', () => {
    expect(matchLabel(withResults('e', 3, SEARCH_HIGHLIGHT_LIMIT))).toBe('4 of 1000+')
    expect(matchLabel(withResults('e', -1, SEARCH_HIGHLIGHT_LIMIT))).toBe('1000+ matches')
  })

  it('shows an exact total right up to the ceiling', () => {
    expect(matchLabel(withResults('e', 0, SEARCH_HIGHLIGHT_LIMIT - 1))).toBe('1 of 999')
  })
})

describe('canStep', () => {
  it('is dead until there is something to step through', () => {
    expect(canStep(EMPTY_PANE_SEARCH)).toBe(false)
    expect(canStep(withResults('error', -1, 0))).toBe(false)
    expect(canStep(withResults('error', 0, 2))).toBe(true)
  })
})

describe('searchFieldAction', () => {
  it('steps forward on Enter and back on Shift+Enter', () => {
    expect(searchFieldAction(key({ key: 'Enter' }))).toBe('next')
    expect(searchFieldAction(key({ key: 'Enter', shiftKey: true }))).toBe('previous')
  })

  it('closes on Escape', () => {
    expect(searchFieldAction(key({ key: 'Escape' }))).toBe('close')
  })

  it('ignores ordinary typing', () => {
    expect(searchFieldAction(key({ key: 'e' }))).toBeNull()
    expect(searchFieldAction(key({ key: 'ArrowDown' }))).toBeNull()
  })

  it('declines anything wearing the app modifier, which the window handler owns', () => {
    expect(searchFieldAction(key({ key: 'Enter', metaKey: true }))).toBeNull()
    expect(searchFieldAction(key({ key: 'Enter', ctrlKey: true }))).toBeNull()
    expect(searchFieldAction(key({ key: 'Escape', altKey: true }))).toBeNull()
  })
})

describe('toFindOptions', () => {
  it('never treats the typed term as a pattern', () => {
    const options = toFindOptions({ caseSensitive: false, wholeWord: false }, DECORATIONS, true)
    expect(options.regex).toBe(false)
  })

  it('passes the toggles and the decorations through unchanged', () => {
    const options = toFindOptions({ caseSensitive: true, wholeWord: true }, DECORATIONS, false)
    expect(options).toMatchObject({ caseSensitive: true, wholeWord: true, incremental: false })
    expect(options.decorations).toBe(DECORATIONS)
  })
})
