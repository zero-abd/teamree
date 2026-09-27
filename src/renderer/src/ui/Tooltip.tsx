// A hidden label, shown after a beat on hover or focus, on the inverted ground; never a visible label twice.

import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

export const TOOLTIP_DELAY_MS = 450

type Anchor = { x: number; y: number }

type TooltipProps = {
  label: string
  /** One element that takes a ref and pointer and focus handlers. */
  children: ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>
}

export function Tooltip({ label, children }: TooltipProps): React.JSX.Element {
  const target = useRef<HTMLElement | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const show = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const box = target.current?.getBoundingClientRect()
      if (box !== undefined) setAnchor({ x: box.left + box.width / 2, y: box.bottom + 6 })
    }, TOOLTIP_DELAY_MS)
  }
  // Leaves at once: a tooltip that lingers covers the next thing pointed at.
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setAnchor(null)
  }

  const own = children.props
  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      target.current = node
    },
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event)
      show()
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      own.onPointerLeave?.(event)
      hide()
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      own.onFocus?.(event)
      show()
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      own.onBlur?.(event)
      hide()
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      own.onPointerDown?.(event)
      hide()
    }
  })

  return (
    <>
      {trigger}
      {anchor === null
        ? null
        : createPortal(
            <span className="tooltip" role="tooltip" style={{ left: anchor.x, top: anchor.y }}>
              {label}
            </span>,
            document.body
          )}
    </>
  )
}
