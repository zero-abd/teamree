// A minimal modal: focus moves in on open, is trapped while open, and returns to whatever opened it.
// Escape and a backdrop click dismiss. Several can be open; see the stack below.

import { createContext, useCallback, useContext, useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Every mounted modal, in opening order. Only the last handles keys: a remote-keystrokes question can
 * open over another dialog, and two window listeners would give two answers to Tab and Escape.
 */
const stack: symbol[] = []

/** Inner popups register here to take Escape, since this modal listens in the capture phase. */
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
  // A symbol, not a position, so a modal leaving from the middle of the stack removes itself.
  const idRef = useRef(Symbol('modal'))
  // Through a ref: a countdown dialog hands a fresh callback every second, which re-armed this and
  // dragged focus back to the first control.
  const close = useRef(onClose)
  close.current = onClose

  const register = useCallback((claim: EscapeClaim) => {
    claims.current.add(claim)
    return () => {
      claims.current.delete(claim)
    }
  }, [])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const id = idRef.current
    stack.push(id)
    // The control marked safe, else the first, so Enter goes where the focus ring is.
    ;(panel?.querySelector<HTMLElement>('[data-default]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE))?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      // Not the innermost modal: no key is ours, the Tab trap included.
      if (stack[stack.length - 1] !== id) return
      if (event.key === 'Escape') {
        event.preventDefault()
        for (const claim of [...claims.current]) {
          if (claim()) return
        }
        close.current()
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
      const wasInnermost = stack[stack.length - 1] === id
      const at = stack.lastIndexOf(id)
      if (at !== -1) stack.splice(at, 1)
      // Only the modal that had the keyboard hands it back, or focus would leave a panel still on screen.
      if (wasInnermost) opener?.focus?.()
    }
  }, [])

  return (
    <div className="modal-layer" onMouseDown={() => close.current()}>
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
        {/* The frame pads the body on the same edge as the head. Content
            classes bring their own layout and never their own inset, so a
            sentence under a title starts where the title does. */}
        <div className="modal__body">
          <EscapeClaims value={register}>{children}</EscapeClaims>
        </div>
      </div>
    </div>
  )
}
