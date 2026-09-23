// A minimal modal: focus moves in on open, is trapped while open, and returns
// to whatever opened it on close. Escape and a backdrop click both dismiss.
//
// More than one can be open at a time, which is newer than the rest of this
// file and is the reason for the stack below.

import { createContext, useCallback, useContext, useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Every modal currently mounted, in the order they opened.
 *
 * There used to be at most one. `dialog` in the store holds a single value, so
 * opening the next dialog replaced the last, and a modal could take the window
 * in the capture phase without asking whether anything else already had it.
 * That stopped being true when a question about a teammate's keystrokes became
 * a modal: it is not something this user opened, it arrives on somebody else's
 * schedule, and it renders above whatever they were already in the middle of.
 *
 * Two instances both listening on the window is two answers to every key. The
 * panel underneath would wrap Tab back into itself — pulling the focus out of
 * the dialog on top and into one the scrim is covering — and an Escape aimed at
 * what is on screen would close what is not. So the last one opened handles
 * keys and the rest go inert until it leaves, which is what "modal" means.
 */
const stack: symbol[] = []

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
  // This instance's entry in the stack above. A symbol rather than a position,
  // so a modal that leaves from the middle — which is what happens when a
  // consent prompt outlives the dialog it opened over — takes its own out.
  const idRef = useRef(Symbol('modal'))
  // Read through a ref so that arming the panel does not depend on the identity
  // of the callback it was handed. A dialog that counts a deadline down
  // re-renders every second and hands over a fresh function each time; when
  // that re-armed this effect, the focus was dragged back to the first control
  // once a second, on the one dialog where choosing an answer by keyboard is
  // the whole interaction.
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
    // The control marked as the safe answer, if the dialog named one, else the
    // first. A confirm names its cancel or its confirm depending on which one
    // is safe to press by reflex, and Enter then goes where the focus ring is.
    ;(panel?.querySelector<HTMLElement>('[data-default]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE))?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      // Not the innermost modal, so not this one's key. Checked first, and for
      // every key rather than only for Escape: the Tab trap below is just as
      // much a claim on the keyboard as the dismissal is.
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
      // Only the modal that had the keyboard hands it back. One closing from
      // underneath another — a dialog dismissed by something other than the
      // person while a keystroke question stands over it — would otherwise pull
      // the focus out of the panel still on screen and into a panel that is not.
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
