// A parent's Children in its Changes panel: where each child stands against the parent, and landing
// them from here. A conflict is resolved in that child's own merge, not here.

import { useEffect, useRef } from 'react'
import { firstSentence } from '../../state/messages'
import { useOverlaps } from '../../state/overlapStore'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { worktreeDisplay, worktreeLabel } from '../../sidebar/worktreeDisplay'
import { childRows, mergeable, readyToMerge, type ChildRow } from './childrenModel'
import { useChildren } from './childrenStore'

/** The worktree's direct children as the panel lists them. */
export function useChildRows(worktreeId: string): ChildRow[] {
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const terminals = useWorkspaceStore((state) => state.terminals)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
  const landings = useWorkspaceStore((state) => state.landings)
  const projectId = worktrees.find((entry) => entry.id === worktreeId)?.projectId
  const overlaps = useOverlaps((state) => (projectId === undefined ? undefined : state.byProject[projectId]))
  return childRows(worktreeId, {
    worktrees,
    terminals: Object.values(terminals),
    statuses,
    mergePreviews,
    landings,
    ...(overlaps === undefined ? {} : { overlaps }),
    now: Date.now()
  })
}

export function ChildrenSection({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const parent = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const confirmCleanUp = useWorkspaceStore((state) => state.confirmCleanUp)
  const rows = useChildRows(worktreeId)
  const merging = useChildren((state) => state.merging[worktreeId])
  const lastStop = useChildren((state) => state.stopped[worktreeId])
  const reveal = useChildren((state) => state.reveal === worktreeId)
  const mergeChildren = useChildren((state) => state.mergeChildren)
  const section = useRef<HTMLElement | null>(null)
  const shown = rows.length > 0

  useEffect(() => {
    if (!reveal || !shown) return
    section.current?.scrollIntoView({ block: 'start' })
    useChildren.getState().revealed()
  }, [reveal, shown])

  if (parent === undefined || !shown) return null
  const into = worktreeLabel(worktreeDisplay(parent))
  const ready = readyToMerge(rows)
  const landed = rows.filter((row) => row.landed)
  const busy = merging !== undefined
  const stopped = rows.find((row) => row.worktreeId === lastStop?.worktreeId)
  // Landed since, through its own merge: nothing is stopped any more.
  const stop = stopped?.landed === true ? undefined : lastStop

  return (
    <section className="children" aria-label="Children" ref={section}>
      <h3 className="commits__title">
        Children
        <span className="panel__count">{rows.length}</span>
        <span className="children__actions">
          {landed.length > 0 && !busy ? (
            <button
              type="button"
              className="button button--small"
              onClick={() =>
                void confirmCleanUp(
                  parent.projectId,
                  landed.map((row) => row.worktreeId)
                )
              }
            >
              {`Clean Up ${landed.length} Landed`}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--small button--primary"
            disabled={busy || ready.length === 0}
            title={ready.map((row) => row.title).join('\n') || undefined}
            onClick={() =>
              void mergeChildren(
                worktreeId,
                ready.map((row) => row.worktreeId)
              )
            }
          >
            Merge All Ready
          </button>
        </span>
      </h3>
      {stop === undefined ? null : (
        <p className="children__stop" role="alert" title={stop.error}>
          {`Stopped at ${stopped?.title ?? 'a child'}: ${
            stop.conflicts.length > 0 ? `conflicts in ${stop.conflicts.join(', ')}` : stop.error
          }`}
          <button
            type="button"
            className="button button--small"
            onClick={() => openDialog({ kind: 'confirm-merge', worktreeId: stop.worktreeId })}
          >
            {stop.conflicts.length > 0 ? 'Resolve…' : 'Merge…'}
          </button>
        </p>
      )}
      <ul className="children__list">
        {rows.map((row) => (
          <li key={row.worktreeId} className="child" aria-label={row.title}>
            <button
              type="button"
              className="child__name"
              title={row.title}
              onClick={() => void openWorktree(row.worktreeId)}
            >
              {row.title}
            </button>
            <span className={`child__stage child__stage--${row.stage}`}>{row.stage}</span>
            <ChildFacts row={row} into={into} />
            {mergeable(row) ? (
              <button
                type="button"
                className="button button--small child__merge"
                disabled={busy}
                title={`Merge into ${into}`}
                onClick={() => void mergeChildren(worktreeId, [row.worktreeId])}
              >
                {merging === row.worktreeId ? 'Merging…' : 'Merge'}
              </button>
            ) : null}
            {row.report === undefined ? null : (
              <span className="child__report" title={row.report}>
                {`${row.stage === 'failed' ? '✗' : '✓'} ${firstSentence(row.report)}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** `↑2 ↓1`, uncommitted files, and the files a merge would stop on. */
function ChildFacts({ row, into }: { row: ChildRow; into: string }): React.JSX.Element | null {
  if (row.landed) return null
  const arrows = [row.ahead > 0 ? `↑${row.ahead}` : '', row.behind > 0 ? `↓${row.behind}` : '']
    .filter(Boolean)
    .join(' ')
  const conflict = [
    ...(row.conflicts.length > 0 ? [`Conflicts with ${into} in ${row.conflicts.join(', ')}`] : []),
    ...row.siblingConflicts.map((other) => `Conflicts with ${other.title} in ${other.paths.join(', ')}`)
  ].join('\n')
  return (
    <>
      {arrows === '' ? null : <span className="child__arrows">{arrows}</span>}
      {row.uncommitted > 0 ? (
        <span className="child__uncommitted" title={`${row.uncommitted} uncommitted`}>
          {`✎${row.uncommitted}`}
        </span>
      ) : null}
      {conflict !== '' ? (
        <span className="child__conflict" role="img" aria-label={conflict} title={conflict}>
          ⚠
        </span>
      ) : null}
    </>
  )
}
