// Appearance at the workspace's right edge, over the panes with no scrim, so every change is judged on the
// live window. Not modal: the panes stay usable, so Escape closes it only from inside.

import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { AppearanceSettings } from './AppearanceSettings'

export function AppearanceSheet(): React.JSX.Element {
  const showAppearance = useWorkspaceStore((state) => state.showAppearance)
  const sheet = useRef<HTMLElement>(null)

  useEffect(() => {
    sheet.current?.focus()
  }, [])

  return (
    <aside
      className="appearance-sheet"
      aria-label="Appearance"
      tabIndex={-1}
      ref={sheet}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        showAppearance(false)
      }}
    >
      <header className="appearance-sheet__head">
        <h2 className="appearance-sheet__title">Appearance</h2>
        <button
          type="button"
          className="page__close"
          title="Close"
          aria-label="Close Appearance"
          onClick={() => showAppearance(false)}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </header>
      <div className="appearance-sheet__body">
        <AppearanceSettings />
      </div>
    </aside>
  )
}
