// A minimal modal: focus moves in on open, is trapped while open, and returns
// to whatever opened it on close. Escape and a backdrop click both dismiss.

import { createContext, useCallback, useContext, useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Escape has to reach the innermost thing that is open. This modal listens on
 * the window in the capture phase, so a popup inside it cannot claim the key by
 * stopping propagation — it registers here instead, and takes Escape for itself
 * by returning true.
 */
type EscapeClaim = () => boolean

const EscapeClaims = createContext<((claim: EscapeClaim) => () => void) | null>(null)

/** Gives an inner popup first refusal on Escape while that popup is open. */
export function useEscapeClaim(claim: EscapeClaim): void {
  const register = useContext(EscapeClaims)
  const latest = useRef(claim)
  latest.current = claim

  useEffect(() => {
    if (!register) return
    return register(() => latest.current())
  }, [register])
}

type ModalProps = {
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
}

export function Modal({ title, description, onClose, children }: ModalProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const claims = useRef(new Set<EscapeClaim>())

  const register = useCallback((claim: EscapeClaim) => {
    claims.current.add(claim)
    return () => {
      claims.current.delete(claim)
    }
  }, [])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        for (const claim of [...claims.current]) {
          if (claim()) return
        }
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const targets = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => node.offsetParent !== null)
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      opener?.focus?.()
    }
  }, [onClose])

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">{title}</h2>
          {description ? <p className="modal__description">{description}</p> : null}
        </header>
        <EscapeClaims value={register}>{children}</EscapeClaims>
      </div>
    </div>
  )
}
