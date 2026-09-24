// The frame Settings, Help, Teamwork and All panes share: a head with the title and a ×, the page's own
// controls under them, then one measured column that scrolls under it.

import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import { modalOnScreen } from '../dialogs/modalLayer'
import { useWorkspaceStore } from '../state/workspaceStore'

type PageFrameProps = {
  /** The landmark's name. */
  label: string
  title: string
  lede?: ReactNode
  actions?: ReactNode
  onClose: () => void
  closeTitle?: string
  bodyRef?: Ref<HTMLDivElement>
  bodyTestId?: string
  /** The page takes the focus on open and whenever this changes; `false` leaves the focus to the page. */
  focusKey?: string | false
  children: ReactNode
}

export function PageFrame({
  label,
  title,
  lede,
  actions,
  onClose,
  closeTitle = 'Back to the panes',
  bodyRef,
  bodyTestId,
  focusKey = '',
  children
}: PageFrameProps): React.JSX.Element {
  // Capture phase, so a focused pane cannot eat Escape first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // `modalOnScreen`, not `dialog`: a remote-keystrokes question is not in `dialog` and would
      // otherwise have the page close under its scrim.
      if (modalOnScreen(useWorkspaceStore.getState())) return
      // A field with something of its own to cancel takes Escape first.
      if (event.target instanceof Element && event.target.closest('[data-own-escape]')) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // Opened from a button elsewhere, so focus has to follow; the region, so Tab starts at the top.
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focusKey !== false) region.current?.focus()
  }, [focusKey])

  return (
    <main className="workspace page" aria-label={label} tabIndex={-1} ref={region}>
      <header className="page__head">
        <div className="page__column">
          <div className="page__head-row">
            <div className="page__identity">
              <h1 className="page__title">{title}</h1>
              {lede === undefined ? null : <p className="page__lede">{lede}</p>}
            </div>
            <button
              type="button"
              className="page__close"
              title={closeTitle}
              aria-label="Back to the panes"
              onClick={onClose}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 3 L9 9 M9 3 L3 9" />
              </svg>
            </button>
          </div>
          {actions === undefined ? null : <div className="page__actions">{actions}</div>}
        </div>
      </header>

      <div className="page__body" ref={bodyRef} data-testid={bodyTestId}>
        <div className="page__column">{children}</div>
      </div>
    </main>
  )
}
