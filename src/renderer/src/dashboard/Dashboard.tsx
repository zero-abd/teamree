// Every pane in the window, flat, ordered by what needs a person. It takes the main area: it is read
// across worktrees and every row is a way out. PTYs live in the runtime, so panes keep running.

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  agoLabel,
  dotClass,
  dotTone,
  sinceLabel,
  TONE_LABEL,
  TONES_BY_ATTENTION,
  truncateName
} from '../sidebar/agentRows'
import { useNow } from '../state/useNow'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { PageFrame } from '../workspace/PageFrame'
import { dashboardRows, toneCounts } from './dashboardRows'

export function Dashboard(): React.JSX.Element {
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)

  const now = useNow()
  const paneList = useMemo(() => Object.values(terminals), [terminals])
  const rows = useMemo(
    () => dashboardRows({ terminals: paneList, worktrees, projects, now }),
    [paneList, worktrees, projects, now]
  )
  const counts = useMemo(() => toneCounts(rows), [rows])

  // "Said something since I last looked"; not remembered across launches, or the board would hide rows.
  const [unreadOnly, setUnreadOnly] = useState(false)
  const unread = useUnreadPanes()
  const shown = useMemo(
    () => (unreadOnly ? rows.filter((row) => unread.has(row.terminalId)) : rows),
    [rows, unread, unreadOnly]
  )

  // Focus the first row once there is one: the board opens before `bootstrap` answers, and the ref keeps
  // it to once, since `rows` rebuilds every second for the "quiet for" column.
  const list = useRef<HTMLUListElement>(null)
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || shown.length === 0) return
    const first = list.current?.querySelector('button')
    if (!first) return
    landed.current = true
    first.focus()
  }, [shown.length])

  return (
    <PageFrame
      label="Every pane"
      title="All panes"
      lede={
        shown.length === 0
          ? 'No panes'
          : `${shown.length} pane${shown.length === 1 ? '' : 's'} across ${worktreeCount(shown)} worktree${
              worktreeCount(shown) === 1 ? '' : 's'
            }`
      }
      actions={
        <>
          <ul className="board__counts" aria-label="Panes by state">
            {TONES_BY_ATTENTION.map((tone) => (
              <li key={tone} className={`board-count${counts[tone] === 0 ? ' board-count--zero' : ''}`}>
                <span className={dotClass(tone)} aria-hidden="true" />
                <span className="board-count__number">{counts[tone]}</span>
                <span className="board-count__label">{TONE_LABEL[tone]}</span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className={`button button--ghost button--small${unreadOnly ? ' button--on' : ''}`}
            aria-pressed={unreadOnly}
            title="Only panes that have printed since you last read them"
            onClick={() => setUnreadOnly((on) => !on)}
          >
            Unread only
          </button>
        </>
      }
      onClose={toggleDashboard}
      focusKey={false}
    >
      {shown.length === 0 ? (
        <div className="placeholder">
          <h2 className="placeholder__title">{unreadOnly && rows.length > 0 ? 'Nothing unread' : 'Nothing running'}</h2>
        </div>
      ) : (
        <ul className="board__list" ref={list}>
          {shown.map((row) => {
            const tone = dotTone(row.activity, row.agent)
            return (
              <li key={row.terminalId}>
                <button
                  type="button"
                  className={`board-row board-row--${row.activity}${
                    unread.has(row.terminalId) ? ' board-row--unread' : ''
                  }`}
                  title={`${row.label} in ${row.worktreeName} · ${TONE_LABEL[tone]}${
                    unread.has(row.terminalId) ? ' · unread' : ''
                  } · last output ${agoLabel(row.quietFor)}`}
                  onClick={() => void revealPane(row.worktreeId, row.terminalId)}
                >
                  <span className={dotClass(tone, unread.has(row.terminalId))} aria-hidden="true" />
                  <span className="board-row__what">
                    <span className="board-row__label">{truncateName(row.label)}</span>
                    {/* An agent pane is named by its agent, so only a shell needs saying. */}
                    {row.agent ? null : <span className="chip board-row__kind">shell</span>}
                  </span>
                  <span className="board-row__state">{TONE_LABEL[tone]}</span>
                  <span className="board-row__where">
                    <span className="board-row__worktree">{row.worktreeName}</span>
                    <span className="board-row__branch">{row.branch}</span>
                  </span>
                  <span className="board-row__project">{row.projectName}</span>
                  <span className="board-row__since">{sinceLabel(row.quietFor)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </PageFrame>
  )
}

function worktreeCount(rows: readonly { worktreeId: string }[]): number {
  return new Set(rows.map((row) => row.worktreeId)).size
}
