// A project's row in the tree: folds its worktrees, and has a menu on right-click, ⇧F10 or the menu key.

import { useRef, useState } from 'react'
import type { Project } from '@shared/entities'
import { RowMenu, type RowMenuAnchor } from './RowMenu'

type ProjectHeadProps = {
  project: Project
  collapsed: boolean
  /** Your worktrees, then theirs, counted apart. */
  count: number
  theirs: number
  onToggle: () => void
  onNewTask: () => void
}

export function ProjectHead({
  project,
  collapsed,
  count,
  theirs,
  onToggle,
  onNewTask
}: ProjectHeadProps): React.JSX.Element {
  const row = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)

  /** Under the row, for a menu nobody pointed at. */
  const rowAnchor = (): RowMenuAnchor => {
    const rect = row.current?.getBoundingClientRect()
    return rect === undefined ? { x: 0, y: 0 } : { x: rect.left + 12, y: rect.bottom }
  }

  const closeMenu = (): void => {
    setMenuAt(null)
    row.current?.focus()
  }

  return (
    <div
      className="project__head"
      onContextMenu={(event) => {
        event.preventDefault()
        // As on a worktree row: the keys raise this with no coordinates.
        const pointed = event.detail > 0 && (event.clientX > 0 || event.clientY > 0)
        setMenuAt(pointed ? { x: event.clientX, y: event.clientY } : rowAnchor())
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        setMenuAt(rowAnchor())
      }}
    >
      <button
        type="button"
        className="project__toggle"
        ref={row}
        role="treeitem"
        aria-level={1}
        aria-expanded={!collapsed}
        tabIndex={-1}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          if (event.key === (collapsed ? 'ArrowRight' : 'ArrowLeft')) {
            event.preventDefault()
            onToggle()
          }
        }}
      >
        <svg className={`chevron${collapsed ? '' : ' chevron--open'}`} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 L8.5 6 L4.5 9.5" />
        </svg>
        <span className="project__name">{project.name}</span>
        <span className="project__count">{count}</span>
        {theirs > 0 ? (
          <span
            className="project__count project__count--teammate"
            title={`${theirs} teammate worktree${theirs === 1 ? '' : 's'}`}
          >
            {`+${theirs}`}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="button button--ghost button--icon"
        tabIndex={-1}
        title={`New task in ${project.name}`}
        aria-label={`New task in ${project.name}`}
        onClick={onNewTask}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M7 2.5 L7 11.5 M2.5 7 L11.5 7" />
        </svg>
      </button>
      {menuAt === null ? null : (
        <RowMenu
          label={`Actions for ${project.name}`}
          items={[{ label: 'New Task…', onChoose: onNewTask }]}
          anchor={menuAt}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
