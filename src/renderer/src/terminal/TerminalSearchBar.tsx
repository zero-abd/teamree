// The find bar floating over one pane. It holds no state of its own: every
// decision it needs has already been made in paneSearchModel, which is why
// this file is only markup and event forwarding.

import { useEffect, useRef } from 'react'
import { canStep, matchLabel, searchFieldAction, type PaneSearchOptions, type PaneSearchState } from './paneSearchModel'

type TerminalSearchBarProps = {
  state: PaneSearchState
  /**
   * Changes every time the shortcut is pressed. Pressing it again while the
   * bar is already up should reclaim the field and select what is in it, the
   * way a second press does anywhere else.
   */
  focusToken: number
  /** Where counting stops; the default is the terminal's. */
  limit?: number
  onQueryChange: (value: string) => void
  onToggle: (option: keyof PaneSearchOptions) => void
  onStep: (direction: 'next' | 'previous') => void
  onClose: () => void
}

export function TerminalSearchBar({
  state,
  focusToken,
  limit,
  onQueryChange,
  onToggle,
  onStep,
  onClose
}: TerminalSearchBarProps): React.JSX.Element {
  const fieldRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.focus()
    field.select()
  }, [focusToken])

  const label = matchLabel(state, limit)
  const steppable = canStep(state)
  const missed = state.query !== '' && state.total === 0

  return (
    <div className="pane-search" role="search">
      <input
        ref={fieldRef}
        className="pane-search__field"
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="Find in pane"
        aria-label="Find in pane"
        value={state.query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          const action = searchFieldAction(event)
          if (!action) return
          event.preventDefault()
          // Escape and Enter both mean something to the shell behind this bar;
          // stopping them here keeps them from reaching it once handled.
          event.stopPropagation()
          if (action === 'close') onClose()
          else onStep(action)
        }}
      />

      <span
        className={`pane-search__count${missed ? ' pane-search__count--missed' : ''}`}
        aria-live="polite"
        role="status"
      >
        {label}
      </span>

      <button
        type="button"
        className="pane-search__toggle"
        aria-pressed={state.options.caseSensitive}
        aria-label="Match case"
        title="Match case"
        onClick={() => onToggle('caseSensitive')}
      >
        Aa
      </button>
      <button
        type="button"
        className="pane-search__toggle pane-search__toggle--word"
        aria-pressed={state.options.wholeWord}
        aria-label="Match whole word"
        title="Match whole word"
        onClick={() => onToggle('wholeWord')}
      >
        ab
      </button>

      <button
        type="button"
        className="button button--ghost button--icon"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={!steppable}
        onClick={() => onStep('previous')}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 7.5 L6 4 L9.5 7.5" />
        </svg>
      </button>
      <button
        type="button"
        className="button button--ghost button--icon"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={!steppable}
        onClick={() => onStep('next')}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 L6 8 L9.5 4.5" />
        </svg>
      </button>
      <button
        type="button"
        className="button button--ghost button--icon"
        title="Close search (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3 L9 9 M9 3 L3 9" />
        </svg>
      </button>
    </div>
  )
}
