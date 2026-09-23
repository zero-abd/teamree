// The menu a sidebar row opens, built out of plain elements: the renderer has
// no Electron in it (`docs/renderer-boundary.md`). Items are `div`s with
// `role="menuitem"`, not buttons, which would activate on Enter and choose twice.

import { useEffect, useRef, useState } from 'react'

export type RowMenuItem = {
  /** What the item says. A label, never a sentence — this is a menu. */
  label: string
  onChoose: () => void
  /** Set apart from what is above it by a rule. The destructive one is. */
  separated?: boolean
  /** Painted as destructive. */
  danger?: boolean
  /** A chord at the row's end, for a row the keyboard already has a way to. */
  hint?: string
  /** A mark before the label. Every row of a menu has one, or none does. */
  icon?: React.ReactNode
}

/** Where the menu goes, in viewport coordinates; `right` hangs it off `x` leftwards. */
export type RowMenuAnchor = { x: number; y: number; align?: 'left' | 'right' }

type RowMenuProps = {
  /** Names the menu for anybody listening rather than looking. */
  label: string
  items: readonly RowMenuItem[]
  anchor: RowMenuAnchor
  /** Closing is the caller's, because the focus that goes back is too. */
  onClose: () => void
  /** The control that opened it, whose press is a toggle rather than a dismissal. */
  opener?: HTMLElement | null
}

export function RowMenu({ label, items, anchor, onClose, opener }: RowMenuProps): React.JSX.Element {
  const menu = useRef<HTMLDivElement | null>(null)
  const entries = useRef<(HTMLDivElement | null)[]>([])
  const [active, setActive] = useState(0)

  // The focus moves to the item, so a screen reader reads the item actually focused.
  useEffect(() => {
    entries.current[active]?.focus()
  }, [active])

  // On `pointerdown` rather than `click`, so a control outside the menu does
  // not have to be pressed twice.
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (menu.current?.contains(event.target as Node) === true) return
      if (opener?.contains(event.target as Node) === true) return
      onClose()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [onClose, opener])

  const choose = (item: RowMenuItem): void => {
    // Closed first, so the focus put back on the row is not taken by whatever the item opens.
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
        // Tab closes rather than moving through the items.
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
      style={
        anchor.align === 'right'
          ? { right: `${window.innerWidth - anchor.x}px`, top: `${anchor.y}px` }
          : { left: `${anchor.x}px`, top: `${anchor.y}px` }
      }
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
          {item.icon === undefined ? null : (
            <span className="row-menu__icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span className="row-menu__label">{item.label}</span>
          {item.hint === undefined ? null : (
            <kbd className="row-menu__hint" aria-hidden="true">
              {item.hint}
            </kbd>
          )}
        </div>
      ))}
    </div>
  )
}
