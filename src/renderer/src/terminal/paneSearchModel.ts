// Everything the find bar decides, with no terminal attached. The emulator is
// imperative and impossible to assert against without a DOM, so the decisions
// that can actually be wrong — when a stale count must be dropped, what "3 of
// 17" reads when the addon stopped counting, which keystroke steps where —
// live here and the component only relays them.

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

/**
 * The addon stops collecting once it has this many hits, so a count that
 * reaches it is a floor and not a total. Passed to the addon as well, so the
 * two numbers cannot disagree about where counting stopped.
 */
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
      // The old tally describes the old term. Keeping it would leave "3 of 17"
      // under a query that matches nothing until the addon gets round to
      // answering, which reads as a result rather than as a pending search.
      return { ...state, query: action.value, current: 0, total: 0 }
    case 'toggle':
      return {
        ...state,
        options: { ...state.options, [action.option]: !state.options[action.option] },
        current: 0,
        total: 0
      }
    case 'results':
      // resultIndex is -1 both before a match is selected and once the active
      // one sits past the limit; either way there is no position to show.
      return {
        ...state,
        current: action.resultIndex < 0 ? 0 : action.resultIndex + 1,
        total: Math.max(0, action.resultCount)
      }
    case 'reset':
      // The query survives, because reopening the bar to search for the same
      // thing again is the common case; the counts do not, because they
      // describe a buffer that has been growing in the meantime.
      return { ...state, current: 0, total: 0 }
  }
}

/**
 * What the counter reads. An empty string means the bar shows nothing at all:
 * an untouched field has neither found nor failed to find anything.
 */
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

/**
 * The field's own keys. Anything carrying the app modifier is declined, so a
 * workspace chord typed with the field focused still reaches the window
 * handler instead of being answered twice.
 */
export function searchFieldAction(event: PaneSearchKeyEvent): PaneSearchKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter') return event.shiftKey ? 'previous' : 'next'
  return null
}

/**
 * The addon's own option shape. `regex` stays off deliberately: a search field
 * over shell output is typed at, not composed in, and a stray `.` or `(` from
 * a path would otherwise match something else entirely.
 */
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
