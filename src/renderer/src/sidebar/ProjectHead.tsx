// A project's row in the tree: folds its worktrees, and has a menu on right-click, ⇧F10 or the menu key.

import { useRef, useState } from 'react'
import type { Project } from '@shared/entities'
import { useWorkspaceStore } from '../state/workspaceStore'
import { agoLabel } from './agentRows'
import { useNestDrop } from './nestDrag'
import { RowMenu, type RowMenuAnchor, type RowMenuItem } from './RowMenu'
import { worktreeDisplay, worktreeLabel } from './worktreeDisplay'
import { DropHint } from './WorktreeRow'

type ProjectHeadProps = {
  project: Project
  collapsed: boolean
  /** Your worktrees, then theirs, counted apart; shown only while folded. */
  count: number
  theirs: number
  onToggle: () => void
  onNewTask: () => void
  /** Opens a branch as it is: `true` lists open pull requests instead. */
  onOpenBranch: (pullRequests: boolean) => void
  /** Remove from teamree: forgets it; the folder stays. */
  onForget: () => void
  /** Move to Trash…: the folder goes to the macOS Trash. */
  onTrash: () => void
}

export function ProjectHead({
  project,
  collapsed,
  count,
  theirs,
  onToggle,
  onNewTask,
  onOpenBranch,
  onForget,
  onTrash
}: ProjectHeadProps): React.JSX.Element {
  const row = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const removedWorktrees = useWorkspaceStore((state) => state.removedWorktrees)
  const loadRemovedWorktrees = useWorkspaceStore((state) => state.loadRemovedWorktrees)
  const restoreWorktree = useWorkspaceStore((state) => state.restoreWorktree)
  // A row dropped here goes to the top level.
  const drop = useNestDrop({ projectId: project.id }, false)
  const openMenu = (anchor: RowMenuAnchor): void => {
    setMenuAt(anchor)
    void loadRemovedWorktrees()
  }
  const removed: RowMenuItem[] = removedWorktrees
    .filter((entry) => entry.projectId === project.id)
    .map((entry) => ({
      label: worktreeLabel(worktreeDisplay(entry)),
      hint: agoLabel(Date.now() - entry.removedAt),
      onChoose: () => void restoreWorktree(project.id, entry.id)
    }))
  const items: RowMenuItem[] = [
    { label: 'New Task…', onChoose: onNewTask },
    { label: 'Open Branch…', onChoose: () => onOpenBranch(false) },
    { label: 'Check Out Pull Request…', onChoose: () => onOpenBranch(true) },
    ...(removed.length === 0 ? [] : [{ label: 'Recently Removed', items: removed, onChoose: () => {} }]),
    { label: 'Remove from teamree', onChoose: onForget, separated: true },
    { label: 'Move to Trash…', onChoose: onTrash, danger: true }
  ]

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
      className={`project__head${
        drop.target === null ? '' : drop.target.allowed ? ' project__head--drop' : ' project__head--no-drop'
      }`}
      {...drop.handlers}
      onContextMenu={(event) => {
        event.preventDefault()
        // As on a worktree row: the keys raise this with no coordinates.
        const pointed = event.detail > 0 && (event.clientX > 0 || event.clientY > 0)
        openMenu(pointed ? { x: event.clientX, y: event.clientY } : rowAnchor())
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        openMenu(rowAnchor())
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
        {collapsed ? <span className="project__count">{count}</span> : null}
        {collapsed && theirs > 0 ? (
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
        title="New Task"
        aria-label={`New Task in ${project.name}`}
        onClick={onNewTask}
      >
        {/* A pencil on a page, not a plus: the plus above adds a project. */}
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3" />
          <path d="M10.3 2.2a1.1 1.1 0 0 1 1.5 1.5L7.2 8.3 5.5 8.8 6 7.1Z" />
        </svg>
      </button>
      {drop.target === null ? null : (
        <DropHint text={drop.target.allowed ? drop.target.hint : drop.target.reason} refused={!drop.target.allowed} />
      )}
      {menuAt === null ? null : (
        <RowMenu label={`Actions for ${project.name}`} items={items} anchor={menuAt} onClose={closeMenu} />
      )}
    </div>
  )
}
