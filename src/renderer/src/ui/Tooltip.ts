// One tooltip for the window: any element with `data-tip` says it after a beat on hover or keyboard focus.
// One set of listeners on the document and one element at a time, so a row that re-renders carries only an attribute.

export const TOOLTIP_DELAY_MS = 400
/** After a tooltip goes, the next shows at once for this long, so a row of icons reads without waiting. */
export const TOOLTIP_WARM_MS = 500
export const TOOLTIP_ID = 'tooltip'
/** A focus this soon after a press came from the pointer, which the hover already covers. */
const POINTER_FOCUS_MS = 600
const GAP_PX = 6
const EDGE_PX = 8

/** An icon's svg carries a tip as well as any element. */
type Tipped = HTMLElement | SVGElement
type Box = { left: number; top: number; right: number; bottom: number }
type Size = { width: number; height: number }

/** Under the target, or over it where under would leave the window; never across it, and inside the edges. */
export function placeTooltip(
  target: Box,
  tip: Size,
  view: Size
): { left: number; top: number; side: 'below' | 'above' } {
  const below = target.bottom + GAP_PX
  const above = target.top - GAP_PX - tip.height
  const fitsBelow = below + tip.height <= view.height - EDGE_PX
  const side = fitsBelow || (above < EDGE_PX && view.height - target.bottom >= target.top) ? 'below' : 'above'
  const centre = (target.left + target.right) / 2
  const left = Math.max(EDGE_PX, Math.min(centre - tip.width / 2, view.width - EDGE_PX - tip.width))
  return { left: Math.round(left), top: Math.round(side === 'below' ? below : above), side }
}

function tipTarget(node: EventTarget | null): Tipped | null {
  if (!(node instanceof Element)) return null
  const found = node.closest<Tipped>('[data-tip]')
  return found !== null && found.dataset.tip !== '' ? found : null
}

/** Starts the window's tooltips; the returned function stops them. */
export function installTooltips(doc: Document = document): () => void {
  const view = doc.defaultView ?? window
  let tip: HTMLElement | null = null
  let current: Tipped | null = null
  let pending: Tipped | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let hiddenAt = -Infinity
  let pressedAt = -Infinity
  let viaFocus = false
  let described = false
  // Escape leaves this one alone until the pointer or the focus moves on.
  let dismissed: Tipped | null = null
  const watch = new view.MutationObserver(() => {
    if (current === null) return
    if (!current.dataset.tip) hide()
    else if (tip?.textContent !== current.dataset.tip) show(current)
  })

  const hide = (): void => {
    clearTimeout(timer)
    pending = null
    if (current === null) return
    watch.disconnect()
    if (described) {
      const rest = (current.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id !== TOOLTIP_ID)
      if (rest.length === 0) current.removeAttribute('aria-describedby')
      else current.setAttribute('aria-describedby', rest.join(' '))
    }
    described = false
    tip?.remove()
    tip = null
    current = null
    hiddenAt = Date.now()
  }

  const show = (target: Tipped, instant = false): void => {
    const text = target.dataset.tip
    if (!target.isConnected || !text) return
    if (current !== target) hide()
    pending = null
    if (tip === null) {
      tip = doc.createElement('div')
      tip.id = TOOLTIP_ID
      tip.className = 'tooltip'
      tip.setAttribute('role', 'tooltip')
      // Straight from a neighbour: a fade would read as the delay coming back.
      if (instant) tip.dataset.instant = ''
    }
    tip.textContent = text
    if (!tip.isConnected) doc.body.append(tip)
    const place = placeTooltip(
      target.getBoundingClientRect(),
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: view.innerWidth, height: view.innerHeight }
    )
    tip.style.left = `${place.left}px`
    tip.style.top = `${place.top}px`
    tip.dataset.side = place.side
    if (current === target) return
    current = target
    watch.observe(target, { attributes: true, attributeFilter: ['data-tip'] })
    // A name that already says it would be read twice; a hidden one is never read.
    if (target.getAttribute('aria-label') === text || target.closest('[aria-hidden="true"]') !== null) return
    const ids = target.getAttribute('aria-describedby')
    target.setAttribute('aria-describedby', ids ? `${ids} ${TOOLTIP_ID}` : TOOLTIP_ID)
    described = true
  }

  const enter = (target: Tipped, focus: boolean): void => {
    if (target === current || target === pending || target === dismissed) return
    const warm = current !== null || Date.now() - hiddenAt < TOOLTIP_WARM_MS
    hide()
    viaFocus = focus
    if (warm) {
      show(target, true)
      return
    }
    pending = target
    timer = setTimeout(() => show(target), TOOLTIP_DELAY_MS)
  }

  const onOver = (event: PointerEvent): void => {
    const target = tipTarget(event.target)
    if (target !== dismissed) dismissed = null
    if (target !== null) enter(target, false)
    else if (!viaFocus) hide()
  }
  const onOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null && !viaFocus) hide()
  }
  const onDown = (): void => {
    pressedAt = Date.now()
    hide()
  }
  const onFocusIn = (event: FocusEvent): void => {
    if (Date.now() - pressedAt < POINTER_FOCUS_MS) return
    dismissed = null
    const target = tipTarget(event.target)
    if (target !== null) enter(target, true)
    else if (viaFocus) hide()
  }
  const onFocusOut = (event: FocusEvent): void => {
    if (viaFocus && tipTarget(event.relatedTarget) !== current) hide()
  }
  // Never swallowed: the pane or dialog under the tooltip still gets its Escape.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (current === null && pending === null)) return
    dismissed = current ?? pending
    hide()
  }
  // A terminal scrolling under new output must not take the tooltip on a tab with it.
  const onScroll = (event: Event): void => {
    if (current !== null && event.target instanceof Node && event.target.contains(current)) hide()
  }
  const onAway = (): void => hide()

  const listeners: [EventTarget, string, EventListener][] = [
    [doc, 'pointerover', onOver as EventListener],
    [doc, 'pointerout', onOut as EventListener],
    [doc, 'pointerdown', onDown],
    [doc, 'focusin', onFocusIn as EventListener],
    [doc, 'focusout', onFocusOut as EventListener],
    [doc, 'keydown', onKey as EventListener],
    [doc, 'scroll', onScroll],
    [doc, 'wheel', onAway],
    [view, 'blur', onAway],
    [view, 'resize', onAway]
  ]
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener, true)
  return () => {
    hide()
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true)
  }
}
