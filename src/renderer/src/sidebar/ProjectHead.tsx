// A project's row in the tree: folds its worktrees, and has a menu on the `⋯`, right-click, ⇧F10 or the menu key.

import { useRef, useState } from 'react'
import type { Project, ProjectBase } from '@shared/entities'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { agoLabel } from './agentRows'
import { baseFreshness } from './baseFreshness'
import { useNestDrop } from './nestDrag'
import { refocus, RowMenu, type MenuClosed, type RowMenuAnchor, type RowMenuItem } from './RowMenu'
import { worktreeDisplay, worktreeLabel } from './worktreeDisplay'
import { DropHint } from './WorktreeRow'
import { Icon } from '../icons/Icon'

type ProjectHeadProps = {
  project: Project
  collapsed: boolean
  /** Your worktrees, then theirs, counted apart; shown only while folded. */
  count: number
  theirs: number
  onToggle: () => void
  onNewTask: () => void
  onNewTaskFromIssue: () => void
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
  onNewTaskFromIssue,
  onOpenBranch,
  onForget,
  onTrash
}: ProjectHeadProps): React.JSX.Element {
  const row = useRef<HTMLButtonElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const removedWorktrees = useWorkspaceStore((state) => state.removedWorktrees)
  const loadRemovedWorktrees = useWorkspaceStore((state) => state.loadRemovedWorktrees)
  const restoreWorktree = useWorkspaceStore((state) => state.restoreWorktree)
  // A row dropped here goes to the top level.
  const drop = useNestDrop({ projectId: project.id }, false)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)
  const openSetting = useWorkspaceStore((state) => state.openSetting)
  const fetchProject = useWorkspaceStore((state) => state.fetchProject)
  const unpushed = useWorkspaceStore((state) => unpushedBase(state.bases[project.id]))
  const anyMerged = useWorkspaceStore((state) =>
    state.worktrees.some((worktree) => worktree.projectId === project.id && state.landings[worktree.id]?.merged)
  )
  const openMenu = (anchor: RowMenuAnchor, from: HTMLElement | null = row.current): void => {
    opener.current = from
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
    { label: 'New Task from Issue…', onChoose: onNewTaskFromIssue },
    { label: 'Open Branch…', onChoose: () => onOpenBranch(false) },
    { label: 'Check Out Pull Request…', onChoose: () => onOpenBranch(true) },
    ...(removed.length === 0 ? [] : [{ label: 'Recently Deleted', items: removed, onChoose: () => {} }]),
    { label: 'Fetch Now', hint: project.baseRef, onChoose: () => void fetchProject(project.id), separated: true },
    ...(unpushed === null
      ? []
      : [
          { label: `Push ${unpushed.branch}`, onChoose: () => openDialog({ kind: 'push-base', projectId: project.id }) }
        ]),
    ...(anyMerged
      ? [{ label: 'Clean Up Merged…', onChoose: () => openDialog({ kind: 'clean-up', projectId: project.id }) }]
      : []),
    { label: 'Teamwork…', onChoose: () => openTeamwork(project.id), separated: true },
    { label: 'Setup Command…', onChoose: () => openSetting('Setup command') },
    { label: 'Remove from teamree', onChoose: onForget, separated: true },
    { label: 'Move to Trash…', onChoose: onTrash, danger: true }
  ]

  /** Under the row, for a menu nobody pointed at. */
  const rowAnchor = (): RowMenuAnchor => {
    const rect = row.current?.getBoundingClientRect()
    return rect === undefined ? { x: 0, y: 0 } : { x: rect.left + 12, y: rect.bottom }
  }

  const closeMenu = (closed?: MenuClosed): void => {
    setMenuAt(null)
    refocus(opener.current, closed)
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
        <Icon name="chevron-right" size={14} className={`chevron${collapsed ? '' : ' chevron--open'}`} />
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
        <Icon name="new-task" size={14} />
      </button>
      <button
        type="button"
        className="button button--ghost button--icon project__more"
        tabIndex={-1}
        title={`More for ${project.name}`}
        aria-label={`More for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          openMenu({ x: rect.right - 8, y: rect.bottom + 2 }, event.currentTarget)
        }}
      >
        <Icon name="more" size={14} />
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

/** The base when it holds commits its upstream lacks, else null. */
function unpushedBase(base: ProjectBase | undefined): ProjectBase | null {
  return base !== undefined && base.ahead > 0 ? base : null
}

/** `main ↑2` beside the base ref while a landing is only local; pressing it asks to push. */
export function UnpushedBase({ projectId }: { projectId: string }): React.JSX.Element | null {
  const base = useWorkspaceStore((state) => unpushedBase(state.bases[projectId]))
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  if (base === null) return null
  const upstream = base.upstream ?? 'origin'
  return (
    <button
      type="button"
      className="project__unpushed"
      tabIndex={-1}
      aria-label={`Push ${base.branch}, ${base.ahead} ahead of ${upstream}`}
      title={`${base.ahead} ahead of ${upstream}`}
      onClick={() => openDialog({ kind: 'push-base', projectId })}
    >
      {`${base.branch} ↑${base.ahead}`}
    </button>
  )
}

/** `can't reach origin` or `fetched 3h ago` beside the base ref; pressing it fetches now. */
export function BaseFreshness({ project }: { project: Project }): React.JSX.Element | null {
  const now = useNow(60_000)
  const fetching = useWorkspaceStore((state) => state.fetching[project.id] === true)
  const fetchProject = useWorkspaceStore((state) => state.fetchProject)
  const words = baseFreshness(project, now)
  if (words === null && !fetching) return null
  return (
    <button
      type="button"
      className={`project__fresh${project.fetch?.failure === undefined ? '' : ' project__fresh--failed'}`}
      tabIndex={-1}
      title="Fetch Now"
      aria-label={`Fetch ${project.baseRef} now${words === null ? '' : `, ${words}`}`}
      disabled={fetching}
      onClick={() => void fetchProject(project.id)}
    >
      {fetching ? 'fetching…' : words}
    </button>
  )
}
