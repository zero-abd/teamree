// One section of the Changes tab as rows, flat or as a folder tree. A row opens its diff; its actions open the
// file, discard, stage or unstage. The keyboard walks every row of every section.

import { useMemo, useState } from 'react'
import type { WorktreeChange } from '@shared/entities'
import { fileLeavesIn, isWorktreeFileLeaf } from '@shared/filePane'
import { fileIconFor } from '../../icons/fileIcon'
import { Icon } from '../../icons/Icon'
import { isViewedRow } from '../../review/reviewModel'
import { useReviewStore } from '../../review/reviewStore'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { anchorAtPointer, Menu, refocus, type MenuAnchor, type MenuItem } from '../../ui/Menu'
import { KIND_LABEL, KIND_LETTER } from './changeKinds'
import { useScmView, type ChangesView } from './scmView'
import {
  canDiscard,
  changeTree,
  counted,
  directoryOf,
  fileNameOf,
  isPartlyStaged,
  nameParts,
  type TreeRow
} from './sourceControl'

export type SectionId = 'staged' | 'unstaged' | 'committed'

type Props = {
  worktreeId: string
  section: SectionId
  rows: readonly WorktreeChange[]
  view: ChangesView
  ticked: ReadonlySet<string>
}

export function ChangeRows({ worktreeId, section, rows, view, ticked }: Props): React.JSX.Element {
  const folded = useScmView((state) => state.folded)
  const setFold = useScmView((state) => state.setFold)
  const shown = useMemo<TreeRow[]>(
    () =>
      view === 'tree'
        ? changeTree(rows, (path) => folded[`${section}:${path}`] === true)
        : rows.map((change) => ({ kind: 'file', change, depth: 0 })),
    [rows, view, folded, section]
  )
  const actions = useRowActions(worktreeId)
  const [menu, setMenu] = useState<{ change: WorktreeChange; at: MenuAnchor; row: HTMLElement } | null>(null)

  return (
    <>
      <ul className="changes__list">
        {shown.map((row) =>
          row.kind === 'folder' ? (
            <li className="changes__item changes__item--folder" key={`folder:${row.path}`}>
              <button
                type="button"
                className="change"
                data-scm-row="folder"
                aria-expanded={row.open}
                title={row.path}
                style={{ ['--depth' as string]: row.depth }}
                onClick={() => setFold(`${section}:${row.path}`, row.open)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault()
                    setFold(`${section}:${row.path}`, event.key === 'ArrowLeft')
                    return
                  }
                  walk(event, actions)
                }}
              >
                <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size={14} />
                <span className="change__path">
                  <span className="change__name">{row.name}</span>
                </span>
              </button>
            </li>
          ) : (
            <FileRow
              key={row.change.path}
              worktreeId={worktreeId}
              section={section}
              change={row.change}
              depth={view === 'tree' ? row.depth : null}
              partly={section === 'staged' && isPartlyStaged(row.change, ticked)}
              ticked={ticked.has(row.change.path)}
              actions={actions}
              onMenu={(at, opener) => setMenu({ change: row.change, at, row: opener })}
            />
          )
        )}
      </ul>
      {menu === null ? null : (
        <Menu
          label={`Actions for ${menu.change.path}`}
          anchor={menu.at}
          onClose={(closed) => {
            refocus(menu.row, closed)
            setMenu(null)
          }}
          items={menuItems(section, menu.change, isPartlyStaged(menu.change, ticked), actions)}
        />
      )}
    </>
  )
}

type RowActions = ReturnType<typeof useRowActions>

function useRowActions(worktreeId: string) {
  const selectChange = useWorkspaceStore((state) => state.selectChange)
  const toggleStaged = useWorkspaceStore((state) => state.toggleStaged)
  const unstagePath = useWorkspaceStore((state) => state.unstagePath)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const openFilePane = useWorkspaceStore((state) => state.openFilePane)
  const setPaneDiff = useWorkspaceStore((state) => state.setPaneDiff)
  const reviewBranch = useReviewStore((state) => state.reviewBranch)
  return {
    diff: (section: SectionId, path: string, pin = false): void => {
      if (section === 'committed') reviewBranch(worktreeId, path)
      else selectChange(path, pin)
    },
    stage: (path: string): void => toggleStaged(path),
    /** Anything git holds leaves the index whole; a tick alone is only unticked. */
    unstage: (change: WorktreeChange, ticked: boolean): void => {
      if (change.staged) void unstagePath(worktreeId, change.path)
      else if (ticked) toggleStaged(change.path)
    },
    discard: (path: string): void => openDialog({ kind: 'confirm-discard', worktreeId, path }),
    /** The file itself, never its diff, even where a diff tab of it is open. */
    open: (path: string): void => {
      openFilePane(worktreeId, path)
      const root = useWorkspaceStore.getState().layouts[worktreeId]?.root ?? null
      const leaf = fileLeavesIn(root).find((entry) => entry.path === path && isWorktreeFileLeaf(entry))
      if (leaf !== undefined) setPaneDiff(leaf.terminalId, false)
    }
  }
}

function FileRow({
  worktreeId,
  section,
  change,
  depth,
  partly,
  ticked,
  actions,
  onMenu
}: {
  worktreeId: string
  section: SectionId
  change: WorktreeChange
  depth: number | null
  partly: boolean
  ticked: boolean
  actions: RowActions
  onMenu: (at: MenuAnchor, row: HTMLElement) => void
}): React.JSX.Element {
  const selected = useWorkspaceStore((state) => section !== 'committed' && state.selectedChangePath === change.path)
  const zoomed = useWorkspaceStore((state) => state.expandedTerminalId !== null)
  const toggleExpandedPane = useWorkspaceStore((state) => state.toggleExpandedPane)
  const hunkPending = useWorkspaceStore((state) => state.hunkPending)
  const viewed = useReviewStore((state) => state.viewed[worktreeId]?.[change.path])
  const uncommitted = section !== 'committed'
  const deleted = change.kind === 'deleted'
  const folderOfNew = change.files !== undefined
  const discardable = uncommitted && canDiscard(change)
  const folder = depth === null ? directoryOf(change.path) : ''
  const name = fileNameOf(change.path)
  const [head, tail] = nameParts(name)
  const flip = (): void => {
    if (section === 'unstaged' || partly) actions.stage(change.path)
    else actions.unstage(change, ticked)
  }

  return (
    <li className={`changes__item${selected ? ' changes__item--selected' : ''}`}>
      <button
        type="button"
        className="change"
        data-scm-row={section}
        data-path={change.path}
        aria-current={selected ? 'true' : undefined}
        title={change.from === undefined ? change.path : `${change.from} → ${change.path}`}
        {...(depth === null ? {} : { style: { ['--depth' as string]: depth } })}
        onClick={() => actions.diff(section, change.path)}
        onDoubleClick={() =>
          deleted || folderOfNew ? actions.diff(section, change.path, true) : actions.open(change.path)
        }
        onContextMenu={(event) => {
          event.preventDefault()
          // The menu key reports no pointer, so the menu hangs under the row.
          const rect = event.currentTarget.getBoundingClientRect()
          const keyed = event.clientX === 0 && event.clientY === 0
          onMenu(
            anchorAtPointer(keyed ? rect.left : event.clientX, keyed ? rect.bottom : event.clientY),
            event.currentTarget
          )
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            actions.diff(section, change.path, event.metaKey || event.ctrlKey)
          } else if (event.key === ' ' && uncommitted) {
            event.preventDefault()
            flip()
          } else if ((event.key === 'Backspace' || event.key === 'Delete') && discardable) {
            event.preventDefault()
            actions.discard(change.path)
          } else if (event.key === 'Escape' && zoomed) {
            event.preventDefault()
            toggleExpandedPane()
          } else walk(event, actions)
        }}
        onKeyUp={(event) => {
          // A button presses itself on Space's key-up; Space here stages.
          if (event.key === ' ') event.preventDefault()
        }}
      >
        <Icon name={folderOfNew ? 'folder' : fileIconFor(name)} size={14} className="change__icon-file" />
        <span className="change__path">
          <span className={`change__name${deleted ? ' change__name--deleted' : ''}`}>
            {tail === '' ? (
              head
            ) : (
              <>
                <span className="change__head">{head}</span>
                <span className="change__tail">{tail}</span>
              </>
            )}
          </span>
          {folder === '' ? null : <span className="change__dir">{folder}</span>}
        </span>
        {partly ? (
          <span className="change__where" data-tip="Partly staged">
            partial
          </span>
        ) : null}
        {uncommitted && isViewedRow(viewed, change) ? (
          <span className="change__viewed" role="img" aria-label="Viewed" data-tip="Viewed">
            ✓
          </span>
        ) : null}
        {change.files !== undefined ? (
          <span className="change__stat">
            {counted(change.files)} {change.files === 1 ? 'file' : 'files'}
          </span>
        ) : change.added === undefined || change.removed === undefined ? null : (
          <span className="change__stat">
            +{change.added} −{change.removed}
          </span>
        )}
      </button>
      <span className="change__actions">
        {deleted || folderOfNew ? null : (
          <button
            type="button"
            className="change__icon"
            aria-label={`Open ${change.path}`}
            data-tip="Open File"
            tabIndex={-1}
            onClick={() => actions.open(change.path)}
          >
            <Icon name="open-file" size={14} />
          </button>
        )}
        {discardable ? (
          <button
            type="button"
            className="change__icon"
            aria-label={`Discard ${change.path}…`}
            data-tip="Discard…"
            tabIndex={-1}
            disabled={hunkPending}
            onClick={() => actions.discard(change.path)}
          >
            <Icon name="discard" size={14} />
          </button>
        ) : null}
        {section === 'unstaged' || partly ? (
          <button
            type="button"
            className="change__icon"
            aria-label={`Stage ${change.path}`}
            data-tip="Stage"
            tabIndex={-1}
            onClick={() => actions.stage(change.path)}
          >
            <Icon name="plus" size={14} />
          </button>
        ) : null}
        {section === 'staged' ? (
          <button
            type="button"
            className="change__icon"
            aria-label={`Unstage ${change.path}`}
            data-tip="Unstage"
            tabIndex={-1}
            disabled={hunkPending && change.staged}
            onClick={() => actions.unstage(change, ticked)}
          >
            <Icon name="minimize" size={14} />
          </button>
        ) : null}
      </span>
      <span className={`change__kind change__kind--${change.kind}`} aria-label={KIND_LABEL[change.kind]}>
        {KIND_LETTER[change.kind]}
      </span>
    </li>
  )
}

function menuItems(section: SectionId, change: WorktreeChange, partly: boolean, actions: RowActions): MenuItem[] {
  const items: MenuItem[] = []
  if (change.kind !== 'deleted' && change.files === undefined) {
    items.push({ label: 'Open File', onChoose: () => actions.open(change.path) })
  }
  items.push({ label: 'Open Changes', onChoose: () => actions.diff(section, change.path, true) })
  if (section === 'unstaged' || partly) items.push({ label: 'Stage', onChoose: () => actions.stage(change.path) })
  if (section === 'staged') items.push({ label: 'Unstage', onChoose: () => actions.unstage(change, !change.staged) })
  if (section !== 'committed' && canDiscard(change)) {
    items.push({ label: 'Discard…', separated: true, onChoose: () => actions.discard(change.path) })
  }
  return items
}

/** ↑ and ↓ move through every row of every section; landing on an uncommitted file opens its diff. */
function walk(event: React.KeyboardEvent<HTMLElement>, actions: RowActions): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (step === 0) return
  const rows = [...(event.currentTarget.closest('.changes')?.querySelectorAll<HTMLElement>('[data-scm-row]') ?? [])]
  const next = rows[rows.indexOf(event.currentTarget) + step]
  if (next === undefined) return
  event.preventDefault()
  next.focus()
  const path = next.dataset.path
  const section = next.dataset.scmRow
  if (path !== undefined && (section === 'staged' || section === 'unstaged')) {
    actions.diff(section, path)
  }
}
