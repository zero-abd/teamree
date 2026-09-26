// The board by task: every worktree in tree order with its stage, its panes as dots, its uncommitted
// lines and its age. Enter or a click opens the worktree.

import { useEffect, useRef, useState } from 'react'
import { hasCheckout, type Worktree, type WorktreeChanges } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { dotClass, sinceLabel, TONE_LABEL } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { TaskRow } from './taskRows'

/** Uncommitted lines for each listed worktree, read again whenever its git status is. */
export function useChangedLines(worktrees: readonly Worktree[]): Record<string, WorktreeChanges> {
  const statuses = useWorkspaceStore((state) => state.statuses)
  const [lines, setLines] = useState<Record<string, WorktreeChanges>>({})
  const readAt = useRef<Record<string, number>>({})
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const due = worktrees
    .filter(hasCheckout)
    .map((worktree) => `${worktree.id}\t${statuses[worktree.id]?.readAt ?? 0}`)
    .join('\n')
  useEffect(() => {
    for (const line of due.split('\n').filter(Boolean)) {
      const [worktreeId = '', at = '0'] = line.split('\t')
      if (readAt.current[worktreeId] === Number(at)) continue
      readAt.current[worktreeId] = Number(at)
      void runtimeClient
        .call('worktree.changes', { worktreeId })
        .then((changes) => {
          if (mounted.current) setLines((previous) => ({ ...previous, [worktreeId]: changes }))
        })
        .catch(() => {})
    }
  }, [due])

  return lines
}

export function TaskBoard({
  rows,
  unread,
  onOpen,
  listRef,
  onKeyDown
}: {
  rows: readonly TaskRow[]
  unread: ReadonlySet<string>
  onOpen: (worktreeId: string) => void
  listRef: React.Ref<HTMLUListElement>
  onKeyDown: (event: React.KeyboardEvent<HTMLUListElement>) => void
}): React.JSX.Element {
  return (
    <>
      <div className="task-head" aria-hidden="true">
        <span>Task</span>
        <span>Stage</span>
        <span>Panes</span>
        <span className="task-head__end">Changes</span>
        <span className="task-head__end">Age</span>
      </div>
      <ul className="board__list" ref={listRef} onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const isUnread = row.panes.some((pane) => unread.has(pane.terminalId))
          return (
            <li key={row.worktreeId} className="board-item board-item--task">
              <button
                type="button"
                className={`board-row task-row task-row--${row.stage}${isUnread ? ' board-row--unread' : ''}`}
                style={row.depth === 0 ? undefined : ({ '--depth': row.depth } as React.CSSProperties)}
                title={[row.title, row.branch, row.projectName].filter(Boolean).join(' · ')}
                onClick={() => onOpen(row.worktreeId)}
              >
                <span className="task-row__task">
                  <span className="task-row__name">{row.title}</span>
                  {row.tally === undefined ? null : (
                    <span className="chip task-row__tally">{`${row.tally.done}/${row.tally.total} done`}</span>
                  )}
                </span>
                <span className="task-row__stage">{row.stage}</span>
                <span className="task-row__panes">
                  {row.panes.map((pane) => (
                    <span
                      key={pane.terminalId}
                      className={dotClass(pane.tone)}
                      role="img"
                      aria-label={`${pane.label} · ${TONE_LABEL[pane.tone]}`}
                      title={`${pane.label} · ${TONE_LABEL[pane.tone]}`}
                    />
                  ))}
                </span>
                <span className="task-row__changes">
                  {row.added ? <span className="task-row__added">+{row.added}</span> : null}
                  {row.removed ? <span className="task-row__removed">−{row.removed}</span> : null}
                  {row.ahead > 0 ? <span className="task-row__ahead">{`↑${row.ahead}`}</span> : null}
                </span>
                <span className="task-row__age">{sinceLabel(row.age)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
