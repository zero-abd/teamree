// Menus float in the page's own scrolled frame, placed against what they belong to.

/** A box in the frame's scrolled coordinates. */
export type Anchor = { top: number; bottom: number; left: number; right: number }

/** Where `rect`, measured on screen, sits in the scrolled `host`. */
export function inFrame(host: HTMLElement, rect: { top: number; bottom: number; left: number; right: number }): Anchor {
  const box = host.getBoundingClientRect()
  const dy = host.scrollTop - box.top
  const dx = host.scrollLeft - box.left
  return { top: rect.top + dy, bottom: rect.bottom + dy, left: rect.left + dx, right: rect.right + dx }
}

/** Puts `element` below the anchor, or above it when there is no room below; never past either side. */
export function placeBeside(
  element: HTMLElement,
  host: HTMLElement,
  anchor: Anchor,
  options: { prefer?: 'above' | 'below'; center?: boolean } = {}
): void {
  const gap = 6
  const { offsetWidth: width, offsetHeight: height } = element
  const top = host.scrollTop
  const bottom = host.scrollTop + host.clientHeight
  const below = anchor.bottom + gap
  const above = anchor.top - height - gap
  const fitsBelow = below + height <= bottom
  const fitsAbove = above >= top
  const y =
    options.prefer === 'above' ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above
  const x = options.center ? (anchor.left + anchor.right) / 2 - width / 2 : anchor.left
  element.style.top = `${Math.max(top, y)}px`
  element.style.left = `${Math.max(gap, Math.min(x, host.clientWidth - width - gap))}px`
}
