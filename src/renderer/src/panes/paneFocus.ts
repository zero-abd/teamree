// A pane that opens on its own (a task started a moment ago, a restore) must not take the keyboard from
// what the person is using: an open dialog, menu or popover, or a text field outside the panes.

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"]'
const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'])

type Holder = 'overlay' | 'field' | null

function holder(): Holder {
  if (document.querySelector('[aria-modal="true"]') !== null) return 'overlay'
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body) return null
  if (active.closest(OVERLAY) !== null) return 'overlay'
  if (active.closest('.pane') !== null) return null
  if (active instanceof HTMLInputElement) return NOT_TEXT.has(active.type) ? null : 'field'
  const typed =
    active instanceof HTMLTextAreaElement || active.closest('[contenteditable]:not([contenteditable="false"])')
  return typed ? 'field' : null
}

/** Calls `take` now if nothing else holds the keyboard, or once the dialog or menu holding it goes; returns a cancel. */
export function focusWhenFree(take: () => void): () => void {
  const now = holder()
  if (now === null) take()
  if (now !== 'overlay') return () => {}

  let timer: ReturnType<typeof setTimeout> | undefined
  const watch = new MutationObserver(() => check())
  const stop = (): void => {
    clearTimeout(timer)
    watch.disconnect()
    document.removeEventListener('focusin', check)
    document.removeEventListener('focusout', check)
  }
  // A turn later: a closing dialog hands focus back to its opener in an effect after it leaves the DOM.
  function check(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const held = holder()
      if (held === 'overlay') return
      stop()
      if (held === null) take()
    })
  }
  watch.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('focusin', check)
  document.addEventListener('focusout', check)
  return stop
}
