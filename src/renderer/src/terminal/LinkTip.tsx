// The tip beside a hovered link: an OSC 8 link's hidden address, else the gesture that follows it,
// on the first few link hovers there have ever been.

import { createPortal } from 'react-dom'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { firstTips, type PaneLinkHost } from './paneLinks'

export type LinkTip = { x: number; y: number; text: string }

const takeTip = firstTips(typeof localStorage === 'undefined' ? undefined : localStorage)

/** The `tip` a pane's link layer calls, saying it through `show`. */
export function linkTips(modifier: PlatformModifier, show: (tip: LinkTip | null) => void): PaneLinkHost['tip'] {
  let last: LinkTip | null = null
  let lastAt = { x: Number.NaN, y: Number.NaN }
  return (at) => {
    if (at === null) return show(null)
    // A repaint under a still pointer hovers the same link again, which is not another look at it.
    if (at.x === lastAt.x && at.y === lastAt.y && at.uri === undefined) return show(last)
    const text = at.uri ?? (takeTip() ? `${modifier.label}-click to open` : null)
    last = text === null ? null : { x: at.x, y: at.y, text }
    lastAt = at
    show(last)
  }
}

/** Drawn over everything, beside the pointer. */
export function LinkTipView({ tip }: { tip: LinkTip | null }): React.JSX.Element | null {
  if (tip === null) return null
  return createPortal(
    <div className="pane-link-tip" role="tooltip" style={{ left: tip.x + 12, top: tip.y + 16 }}>
      {tip.text}
    </div>,
    document.body
  )
}
