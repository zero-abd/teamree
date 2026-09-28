// A parent's Children in its Changes panel: where each child stands against the parent, and landing
// them from here. A conflict is resolved in that child's own merge, not here.

import { useEffect, useId, useRef } from 'react'
import { STAGE_WORD } from '../../dashboard/taskRows'
import { firstSentence } from '../../state/messages'
import { useOverlaps } from '../../state/overlapStore'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { Button } from '../../ui/Button'
import { childRowSpeech } from '../../sidebar/rowSpeech'
import { worktreeDisplay, worktreeLabel } from '../../sidebar/worktreeDisplay'
import { childRows, heldBack, mergeable, readyToMerge, type ChildRow } from './childrenModel'
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
  const confirmCleanUp = useWorkspaceStore((state) => state.confirmCleanUp)
  const rows = useChildRows(worktreeId)
  const merging = useChildren((state) => state.merging[worktreeId])
  const reveal = useChildren((state) => state.reveal === worktreeId)
  const mergeChildren = useChildren((state) => state.mergeChildren)
  const section = useRef<HTMLElement | null>(null)
  const speechId = useId()
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
              {`Delete ${landed.length} Merged`}
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
                ready.map((row) => row.worktreeId),
                heldBack(rows)
              )
            }
          >
            Merge All Ready
          </button>
        </span>
      </h3>
      <LandStops runKey={worktreeId} rows={rows} />
      <ul className="children__list">
        {rows.map((row) => (
          <li key={row.worktreeId} className="child" aria-label={row.title}>
            <button
              type="button"
              className="child__name"
              title={row.title}
              aria-describedby={`${speechId}-${row.worktreeId}`}
              onClick={() => void openWorktree(row.worktreeId)}
            >
              {row.title}
            </button>
            <span id={`${speechId}-${row.worktreeId}`} hidden>
              {childRowSpeech({ ...row, stage: STAGE_WORD[row.stage] }, into)}
            </span>
            {/* Drawn only: the name's description says it in words. */}
            <span className="child__facts" aria-hidden="true">
              <span className={`child__stage child__stage--${row.stage}`}>{STAGE_WORD[row.stage]}</span>
              <ChildFacts row={row} into={into} />
            </span>
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
              <span className="child__report" title={row.report} aria-hidden="true">
                {`${row.stage === 'failed' ? '✗' : '✓'} ${firstSentence(row.report)}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Where the last run under `runKey` stopped, what it skipped, and which push failed, each with the way into that merge. */
export function LandStops({ runKey, rows }: { runKey: string; rows: readonly ChildRow[] }): React.JSX.Element {
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const busy = useChildren((state) => state.merging[runKey] !== undefined)
  const lastStop = useChildren((state) => state.stopped[runKey])
  const lastSkipped = useChildren((state) => state.skipped[runKey])
  const lastMissed = useChildren((state) => state.missed[runKey])
  const unpushed = useChildren((state) => state.unpushed[runKey])
  // Landed since, through its own merge, or gone: nothing is stopped there any more.
  const waiting = (worktreeId: string | undefined): ChildRow | undefined =>
    rows.find((row) => row.worktreeId === worktreeId && !row.landed)
  const stoppedAt = waiting(lastStop?.worktreeId)
  const skipped = busy ? [] : (lastSkipped ?? []).filter((held) => waiting(held.worktreeId) !== undefined)
  const missed = (lastMissed ?? []).flatMap((stop) => {
    const row = waiting(stop.worktreeId)
    return row === undefined ? [] : [{ ...stop, title: row.title }]
  })
  const resolve = (worktreeId: string) => (): void => openDialog({ kind: 'confirm-merge', worktreeId })
  return (
    <>
      {lastStop === undefined || stoppedAt === undefined ? null : (
        <p className="children__stop" role="alert" title={lastStop.error}>
          {`Stopped at ${stoppedAt.title}: ${
            lastStop.conflicts.length > 0 ? `conflicts in ${lastStop.conflicts.join(', ')}` : lastStop.error
          }`}
          <Button size="sm" onClick={resolve(lastStop.worktreeId)}>
            {lastStop.conflicts.length > 0 ? 'Resolve…' : 'Merge…'}
          </Button>
        </p>
      )}
      {(unpushed ?? []).map((line) => (
        <p key={line} className="children__stop" role="alert">
          {line}
        </p>
      ))}
      {missed.map((stop) => (
        <p key={stop.worktreeId} className="children__stop" role="status" title={stop.error}>
          {`Skipped ${stop.title}: ${
            stop.conflicts.length > 0 ? `conflicts in ${stop.conflicts.join(', ')}` : stop.error
          }`}
          <Button size="sm" onClick={resolve(stop.worktreeId)}>
            {stop.conflicts.length > 0 ? 'Resolve…' : 'Merge…'}
          </Button>
        </p>
      ))}
      {skipped.map((held) => (
        <p key={held.worktreeId} className="children__stop" role="status">
          {`Skipped ${held.title}: conflicts with ${held.clashesWith}`}
          <Button size="sm" onClick={resolve(held.worktreeId)}>
            Resolve…
          </Button>
        </p>
      ))}
    </>
  )
}

/** `↑2 ↓1`, uncommitted files, and the files a merge would stop on. */
export function ChildFacts({ row, into }: { row: ChildRow; into: string }): React.JSX.Element | null {
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
        <span className="child__conflict" title={conflict}>
          ⚠
        </span>
      ) : null}
    </>
  )
}
