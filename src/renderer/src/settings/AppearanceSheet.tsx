// Appearance at the workspace's right edge, over the panes with no scrim, so every change is judged on the
// live window. Not modal: Escape closes it only from inside, since Escape in a pane is the program's.

import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { AppearanceSettings } from './AppearanceSettings'
import { Icon } from '../icons/Icon'

export function AppearanceSheet(): React.JSX.Element {
  const showAppearance = useWorkspaceStore((state) => state.showAppearance)
  const sheet = useRef<HTMLElement>(null)

  // Focused mid-slide it is still past the window's edge, and a plain focus scrolls the app over to it.
  useEffect(() => {
    sheet.current?.focus({ preventScroll: true })
  }, [])

  // The toggle is left to its own click, which would reopen what this closed.
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Element
      if (sheet.current?.contains(target) === true) return
      if (target.closest?.('[aria-controls="appearance-sheet"]')) return
      showAppearance(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [showAppearance])

  return (
    <aside
      id="appearance-sheet"
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
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="appearance-sheet__body">
        <AppearanceSettings />
      </div>
    </aside>
  )
}
