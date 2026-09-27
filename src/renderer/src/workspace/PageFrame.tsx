// The frame Settings, Help, Teamwork and All Panes share: the page header, the page's own controls under
// it, then one measured column that scrolls under it.

import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import { modalOnScreen } from '../dialogs/modalLayer'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { IconName } from '../icons/Icon'
import { PageHeader } from '../ui/PageHeader'

type PageFrameProps = {
  /** The landmark's name. */
  label: string
  title: string
  /** The 32px tile before the title. */
  icon?: IconName
  lede?: ReactNode
  /** Right-aligned in the head, before the close. */
  trailing?: ReactNode
  /** A row of the page's own controls under the head. */
  actions?: ReactNode
  onClose: () => void
  closeTitle?: string
  bodyRef?: Ref<HTMLDivElement>
  bodyTestId?: string
  /** The page takes the focus on open and whenever this changes; `false` leaves the focus to the page. */
  focusKey?: string | false
  /** A full-height column left of the head and body, for a page with its own navigation. */
  side?: ReactNode
  children: ReactNode
}

export function PageFrame({
  label,
  title,
  icon,
  lede,
  trailing,
  actions,
  onClose,
  closeTitle = 'Back to the panes',
  bodyRef,
  bodyTestId,
  focusKey = '',
  side,
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
    <main
      className={side === undefined ? 'workspace page' : 'workspace page page--side'}
      aria-label={label}
      tabIndex={-1}
      ref={region}
    >
      {side === undefined ? null : <div className="page__side">{side}</div>}
      <header className="page__head">
        <div className="page__column">
          <PageHeader
            title={title}
            icon={icon}
            lede={lede}
            trailing={trailing}
            onClose={onClose}
            closeTitle={closeTitle}
          />
          {actions === undefined ? null : <div className="page__actions">{actions}</div>}
        </div>
      </header>

      <div className="page__body" ref={bodyRef} data-testid={bodyTestId}>
        <div className="page__column">{children}</div>
      </div>
    </main>
  )
}
