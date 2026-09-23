// The menu a sidebar row opens, built out of plain elements.
//
// Not Electron's `Menu.popup`, and that is not a preference. The renderer has
// no Electron in it at all — `docs/renderer-boundary.md` enumerates the whole
// of what the preload grants, and a native menu is not on it — so a menu drawn
// by the OS would have to be published to the main process, chosen there, and
// routed back, which is the machinery the menu bar already needs and earns. A
// row menu earns none of it: nothing here has to be a menu bar item, nothing
// has to survive the window being closed, and everything in it is a call the
// window can already make.
//
// What a DOM menu does not get for free is the keyboard, so that is written
// out. The row opens this with the context-menu key or Shift+F10 as readily as
// with the right mouse button, arrows move, Enter chooses, Escape closes, and
// the focus goes back to the row it came from — which is the caller's job,
// because the caller is the only thing that still knows which row that was.
//
// The items are `div`s with `role="menuitem"` rather than buttons on purpose. A
// button activates itself on Enter and on Space, which would fire alongside the
// key handling here and choose twice; roving `tabIndex` over non-buttons is
// what the ARIA menu pattern asks for anyway.

import { useEffect, useRef, useState } from 'react'

export type RowMenuItem = {
  /** What the item says. A label, never a sentence — this is a menu. */
  label: string
  onChoose: () => void
  /** Set apart from what is above it by a rule. The destructive one is. */
  separated?: boolean
  /** Painted as destructive. */
  danger?: boolean
}

/** Where the menu goes, in viewport coordinates. */
export type RowMenuAnchor = { x: number; y: number }

type RowMenuProps = {
  /** Names the menu for anybody listening rather than looking. */
  label: string
  items: readonly RowMenuItem[]
  anchor: RowMenuAnchor
  /** Closing is the caller's, because the focus that goes back is too. */
  onClose: () => void
}

export function RowMenu({ label, items, anchor, onClose }: RowMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement | null>(null)
  const entries = useRef<(HTMLDivElement | null)[]>([])
  const [active, setActive] = useState(0)

  // The focus moves to the item rather than the menu keeping it and describing
  // which item is current: a screen reader then reads the item that is actually
  // focused, and there is one place the next keystroke can go.
  useEffect(() => {
    entries.current[active]?.focus()
  }, [active])

  // A press anywhere else is a dismissal. On `pointerdown` rather than `click`
  // so that pressing a control outside the menu does not first have to close it
  // and then be pressed again.
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (menu.current?.contains(event.target as Node) === true) return
      onClose()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [onClose])

  const choose = (item: RowMenuItem): void => {
    // Closed first, so that the focus the caller puts back on the row is not
    // then taken by whatever the item opens — a dialog, most of the time.
    onClose()
    item.onChoose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = items.length - 1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => (index >= last ? 0 : index + 1))
        return
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => (index <= 0 ? last : index - 1))
        return
      case 'Home':
        event.preventDefault()
        setActive(0)
        return
      case 'End':
        event.preventDefault()
        setActive(last)
        return
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const item = items[active]
        if (item) choose(item)
        return
      }
      case 'Escape':
      case 'Tab':
        // Tab closes rather than moving through the items: a menu is one stop
        // on the way round a window, not a dozen.
        event.preventDefault()
        onClose()
        return
      default:
    }
  }

  return (
    <div
      className="row-menu"
      role="menu"
      aria-label={label}
      ref={menu}
      style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`row-menu__item${item.danger === true ? ' row-menu__item--danger' : ''}${
            item.separated === true ? ' row-menu__item--separated' : ''
          }`}
          role="menuitem"
          tabIndex={index === active ? 0 : -1}
          ref={(node) => {
            entries.current[index] = node
          }}
          onClick={() => choose(item)}
          onMouseEnter={() => setActive(index)}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}
