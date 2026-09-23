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
  /** A submenu, opened by hover, click or the right arrow; `onChoose` is then unused. */
  items?: readonly RowMenuItem[]
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
  const subEntries = useRef<(HTMLDivElement | null)[]>([])
  const [active, setActive] = useState(0)
  // `at` is -1 while the submenu is open under the pointer but the focus is still on its parent.
  const [sub, setSub] = useState<{ index: number; at: number } | null>(null)
  const children = sub === null ? undefined : items[sub.index]?.items

  // The focus moves to the item, so a screen reader reads the item actually focused.
  useEffect(() => {
    if (sub !== null && sub.at >= 0) subEntries.current[sub.at]?.focus()
    else entries.current[active]?.focus()
  }, [active, sub])

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

  const choose = (item: RowMenuItem, index: number): void => {
    if (item.items !== undefined) {
      setActive(index)
      setSub({ index, at: 0 })
      return
    }
    // Closed first, so the focus put back on the row is not taken by whatever the item opens.
    onClose()
    item.onChoose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const inSub = sub !== null && sub.at >= 0 && children !== undefined
    const count = inSub ? children.length : items.length
    const at = inSub ? sub.at : active
    const move = (next: number): void => {
      event.preventDefault()
      if (inSub) setSub({ index: sub.index, at: next })
      else {
        setSub(null)
        setActive(next)
      }
    }
    switch (event.key) {
      case 'ArrowDown':
        return move(at >= count - 1 ? 0 : at + 1)
      case 'ArrowUp':
        return move(at <= 0 ? count - 1 : at - 1)
      case 'Home':
        return move(0)
      case 'End':
        return move(count - 1)
      case 'ArrowRight': {
        event.preventDefault()
        if (!inSub && items[active]?.items !== undefined) setSub({ index: active, at: 0 })
        return
      }
      case 'ArrowLeft':
        event.preventDefault()
        if (inSub) setSub(null)
        return
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const item = inSub ? children[sub.at] : items[active]
        if (item) choose(item, active)
        return
      }
      case 'Escape':
        event.preventDefault()
        if (inSub) setSub(null)
        else onClose()
        return
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
        <MenuEntry
          key={item.label}
          item={item}
          focusable={index === active && (sub === null || sub.at < 0)}
          expanded={sub?.index === index}
          ref={(node) => {
            entries.current[index] = node
          }}
          onChoose={() => choose(item, index)}
          onHover={() => {
            setActive(index)
            setSub(item.items === undefined ? null : { index, at: -1 })
          }}
        />
      ))}
      {sub === null || children === undefined ? null : (
        <div
          className="row-menu row-menu--sub"
          role="menu"
          aria-label={items[sub.index]?.label}
          style={besideItem(entries.current[sub.index])}
        >
          {children.map((child, at) => (
            <MenuEntry
              key={child.label}
              item={child}
              focusable={at === sub.at}
              expanded={false}
              ref={(node) => {
                subEntries.current[at] = node
              }}
              onChoose={() => choose(child, at)}
              onHover={() => setSub({ index: sub.index, at })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Against the item's right edge, or its left when the window has no room. */
function besideItem(item: HTMLElement | null | undefined): React.CSSProperties {
  const rect = item?.getBoundingClientRect()
  if (rect === undefined) return {}
  const top = `${rect.top - 4}px`
  return rect.right + 200 > window.innerWidth
    ? { right: `${window.innerWidth - rect.left}px`, top }
    : { left: `${rect.right}px`, top }
}

function MenuEntry({
  item,
  focusable,
  expanded,
  ref,
  onChoose,
  onHover
}: {
  item: RowMenuItem
  focusable: boolean
  expanded: boolean
  ref: React.Ref<HTMLDivElement>
  onChoose: () => void
  onHover: () => void
}): React.JSX.Element {
  const parent = item.items !== undefined
  return (
    <div
      className={`row-menu__item${item.danger === true ? ' row-menu__item--danger' : ''}${
        item.separated === true ? ' row-menu__item--separated' : ''
      }${expanded ? ' row-menu__item--open' : ''}`}
      role="menuitem"
      tabIndex={focusable ? 0 : -1}
      ref={ref}
      {...(parent ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': expanded } : {})}
      onClick={onChoose}
      onMouseEnter={onHover}
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
      {parent ? (
        <svg className="row-menu__more" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M3 1.5 5.5 4 3 6.5" />
        </svg>
      ) : null}
    </div>
  )
}
