// Everything the find bar decides, with no terminal attached, so it can be asserted without a DOM.

import type { ISearchOptions } from '@xterm/addon-search'

export type PaneSearchOptions = {
  caseSensitive: boolean
  wholeWord: boolean
}

export type PaneSearchState = {
  query: string
  options: PaneSearchOptions
  /** Position of the active match, 1-based. 0 when the addon has not settled on one. */
  current: number
  total: number
}

/** The addon stops at this many hits, so reaching it is a floor; passed to the addon too. */
export const SEARCH_HIGHLIGHT_LIMIT = 1000

export const EMPTY_PANE_SEARCH: PaneSearchState = {
  query: '',
  options: { caseSensitive: false, wholeWord: false },
  current: 0,
  total: 0
}

export type PaneSearchAction =
  | { type: 'query'; value: string }
  | { type: 'toggle'; option: keyof PaneSearchOptions }
  | { type: 'results'; resultIndex: number; resultCount: number }
  | { type: 'reset' }

export function paneSearchReducer(state: PaneSearchState, action: PaneSearchAction): PaneSearchState {
  switch (action.type) {
    case 'query':
      if (action.value === state.query) return state
      // The old tally describes the old term; kept, "3 of 17" would read as a result.
      return { ...state, query: action.value, current: 0, total: 0 }
    case 'toggle':
      return {
        ...state,
        options: { ...state.options, [action.option]: !state.options[action.option] },
        current: 0,
        total: 0
      }
    case 'results':
      // -1 before a selection and past the limit alike.
      return {
        ...state,
        current: action.resultIndex < 0 ? 0 : action.resultIndex + 1,
        total: Math.max(0, action.resultCount)
      }
    case 'reset':
      // The query survives reopening; the counts describe a buffer that has since grown.
      return { ...state, current: 0, total: 0 }
  }
}

/** What the counter reads; empty for an untouched field. */
export function matchLabel(state: PaneSearchState, limit = SEARCH_HIGHLIGHT_LIMIT): string {
  if (state.query === '') return ''
  if (state.total === 0) return 'No results'
  const total = state.total >= limit ? `${limit}+` : String(state.total)
  return state.current === 0 ? `${total} matches` : `${state.current} of ${total}`
}

/** Whether stepping can land anywhere, i.e. whether the next/previous controls are live. */
export function canStep(state: PaneSearchState): boolean {
  return state.query !== '' && state.total > 0
}

export type PaneSearchKeyAction = 'next' | 'previous' | 'close'

export type PaneSearchKeyEvent = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/** The field's own keys; app-modifier chords are declined so the window handles them. */
export function searchFieldAction(event: PaneSearchKeyEvent): PaneSearchKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter') return event.shiftKey ? 'previous' : 'next'
  return null
}

/** The addon's options; `regex` off, since a stray `.` or `(` from a path would match something else. */
export function toFindOptions(
  options: PaneSearchOptions,
  decorations: NonNullable<ISearchOptions['decorations']>,
  incremental: boolean
): ISearchOptions {
  return {
    regex: false,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    incremental,
    decorations
  }
}
