// The `/` menu: the blocks in their groups, or the rows that match what was typed.

import { Fragment, useLayoutEffect, useRef } from 'react'
import { BlockIcon } from './blockIcons'
import { inFrame, placeBeside } from './floating'
import type { SlashItem } from './slashCommands'

export type SlashMenuState = {
  items: SlashItem[]
  query: string
  index: number
  rect: DOMRect | null
  command: (item: SlashItem) => void
}

export function SlashMenu({
  menu,
  frame,
  onHover
}: {
  menu: SlashMenuState
  frame: React.RefObject<HTMLDivElement | null>
  onHover: (index: number) => void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const host = frame.current
    const element = list.current
    if (!host || !element || !menu.rect) return
    placeBeside(element, host, inFrame(host, menu.rect))
  }, [frame, menu.rect])

  // Keep the highlighted row in view as the arrows walk the list.
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [menu.index, menu.items])

  const grouped = menu.query.trim().length === 0
  return (
    <div className="md-menu" role="listbox" aria-label="Blocks" ref={list}>
      {menu.items.map((item, index) => (
        <Fragment key={item.id}>
          {grouped && item.group !== menu.items[index - 1]?.group ? (
            <div className="md-menu__group" role="presentation">
              {item.group}
            </div>
          ) : null}
          <div
            role="option"
            aria-selected={index === menu.index}
            className={`md-menu__row${index === menu.index ? ' md-menu__row--current' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (index !== menu.index) onHover(index)
            }}
            onClick={() => menu.command(item)}
          >
            <span className="md-menu__icon">
              <BlockIcon name={item.id} />
            </span>
            <span className="md-menu__label">{item.label}</span>
            {item.detail === undefined ? null : <span className="md-menu__detail">{item.detail}</span>}
          </div>
        </Fragment>
      ))}
    </div>
  )
}
