// Every pane in the window, flat, ordered by what needs a person; or every task, in tree order. It takes
// the main area: it is read across worktrees and every row is a way out. PTYs live in the runtime.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskStage } from '@shared/tasks'

import { PaneGlyph } from '../agents/glyphs'
import {
  agoLabel,
  dotTone,
  sinceLabel,
  TONE_LABEL,
  TONES_BY_ATTENTION,
  truncateName,
  type DotTone
} from '../sidebar/agentRows'
import { AnswerButtons } from '../sidebar/AnswerButtons'
import { usePaneEvidence } from '../sidebar/usePaneEvidence'
import { useNow } from '../state/useNow'
import { useUnreadPanes } from '../state/usePaneSeen'
import { useWorkspaceStore } from '../state/workspaceStore'
import { PageFrame } from '../workspace/PageFrame'
import { Segments } from '../files/FileBar'
import { useTaskTreeStore } from '../state/taskTreeStore'
import { dashboardRows, toneCounts } from './dashboardRows'
import { TaskBoard, useChangedLines } from './TaskBoard'
import { taskRows } from './taskRows'

export function Dashboard(): React.JSX.Element {
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const statuses = useWorkspaceStore((state) => state.statuses)
  const mergePreviews = useWorkspaceStore((state) => state.mergePreviews)
  const landings = useWorkspaceStore((state) => state.landings)
  const mode = useTaskTreeStore((state) => state.boardMode)
  const setMode = useTaskTreeStore((state) => state.setBoardMode)

  const now = useNow()
  const paneList = useMemo(() => Object.values(terminals), [terminals])
  const evidence = usePaneEvidence(paneList, terminals)
  const rows = useMemo(
    () => dashboardRows({ terminals: paneList, worktrees, projects, layouts, now, evidence }),
    [paneList, worktrees, projects, layouts, now, evidence]
  )
  const counts = useMemo(() => toneCounts(rows), [rows])
  const changes = useChangedLines(mode === 'tasks' ? worktrees : [])
  const tasks = useMemo(
    () =>
      mode === 'tasks'
        ? taskRows({ projects, worktrees, terminals: paneList, statuses, mergePreviews, landings, changes, now })
        : [],
    [mode, projects, worktrees, paneList, statuses, mergePreviews, landings, changes, now]
  )

  // A state nothing is in any more has no filter to press, so it filters nothing.
  const [onlyTone, setOnlyTone] = useState<DotTone | null>(null)
  const tone = onlyTone !== null && counts[onlyTone] > 0 ? onlyTone : null

  // "Said something since I last looked"; not remembered across launches, or the board would hide rows.
  const [unreadOnly, setUnreadOnly] = useState(false)
  const unread = useUnreadPanes()
  const stageCounts = useMemo(() => {
    const byStage = Object.fromEntries(STAGES_BY_ATTENTION.map((stage) => [stage, 0])) as Record<TaskStage, number>
    for (const task of tasks) byStage[task.stage] += 1
    return byStage
  }, [tasks])
  const shownTasks = unreadOnly ? tasks.filter((task) => task.panes.some((pane) => unread.has(pane.terminalId))) : tasks
  const shown = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!unreadOnly || unread.has(row.terminalId)) && (tone === null || dotTone(row.activity, row.agent) === tone)
      ),
    [rows, unread, unreadOnly, tone]
  )

  // Focus the first row once there is one: the board opens before `bootstrap` answers, and the ref keeps
  // it to once, since `rows` rebuilds every second for the "quiet for" column.
  const list = useRef<HTMLUListElement>(null)
  const landed = useRef(false)
  const listed = mode === 'tasks' ? shownTasks.length : shown.length
  useEffect(() => {
    if (landed.current || listed === 0) return
    const first = list.current?.querySelector('button')
    if (!first) return
    landed.current = true
    first.focus()
  }, [listed])

  const step = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.board-row') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at === -1) return
    event.preventDefault()
    buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  return (
    <PageFrame
      label="Every pane"
      title="All Panes"
      lede={
        mode === 'tasks'
          ? `${shownTasks.length} task${shownTasks.length === 1 ? '' : 's'}`
          : shown.length === 0
            ? 'No panes'
            : `${shown.length} pane${shown.length === 1 ? '' : 's'} across ${worktreeCount(shown)} worktree${
                worktreeCount(shown) === 1 ? '' : 's'
              }`
      }
      actions={
        <>
          <Segments label="Show">
            <button type="button" aria-pressed={mode === 'panes'} onClick={() => setMode('panes')}>
              Panes
            </button>
            <button type="button" aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>
              Tasks
            </button>
          </Segments>
          {mode === 'tasks' ? (
            <ul className="board__filters" aria-label="Tasks by stage">
              {STAGES_BY_ATTENTION.filter((stage) => stageCounts[stage] > 0).map((stage) => (
                <li key={stage} className="board-filter board-filter--count">
                  <span className={`board-filter__number board-filter__number--${stage}`}>{stageCounts[stage]}</span>{' '}
                  {stage}
                </li>
              ))}
            </ul>
          ) : (
            <ul className="board__filters" aria-label="Panes by state">
              {TONES_BY_ATTENTION.filter((each) => counts[each] > 0).map((each) => (
                <li key={each}>
                  <button
                    type="button"
                    className="board-filter"
                    aria-pressed={each === tone}
                    onClick={() => setOnlyTone(each === tone ? null : each)}
                  >
                    <span className={`board-filter__number board-filter__number--${each}`}>{counts[each]}</span>{' '}
                    {TONE_LABEL[each]}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className={`button button--ghost button--small${unreadOnly ? ' button--on' : ''}`}
            aria-pressed={unreadOnly}
            title="Only panes that have printed since you last read them"
            onClick={() => setUnreadOnly((on) => !on)}
          >
            Unread Only
          </button>
        </>
      }
      onClose={toggleDashboard}
      focusKey={false}
    >
      {mode === 'tasks' && shownTasks.length > 0 ? (
        <TaskBoard
          rows={shownTasks}
          unread={unread}
          onOpen={(worktreeId) => void openWorktree(worktreeId)}
          listRef={list}
          onKeyDown={step}
        />
      ) : listed === 0 ? (
        <div className="placeholder">
          <h2 className="placeholder__title">
            {mode === 'tasks'
              ? unreadOnly && tasks.length > 0
                ? 'Nothing unread'
                : 'No tasks'
              : unreadOnly && rows.length > 0
                ? 'Nothing unread'
                : 'Nothing running'}
          </h2>
        </div>
      ) : (
        <ul className="board__list" ref={list} onKeyDown={step}>
          {shown.map((row) => {
            const state = dotTone(row.activity, row.agent)
            const isUnread = unread.has(row.terminalId)
            const needsYou = state === 'waiting' || state === 'failed'
            const where = [row.worktreeName, row.branch, row.projectName].filter(Boolean).join(' · ')
            return (
              <li key={row.terminalId} className="board-item">
                <button
                  type="button"
                  className={`board-row board-row--${row.activity}${isUnread ? ' board-row--unread' : ''}`}
                  title={`${row.label} in ${where} · ${TONE_LABEL[state]}${
                    isUnread ? ' · unread' : ''
                  } · last output ${agoLabel(row.quietFor)}${row.evidence ? `\nlast printed: ${row.evidence}` : ''}`}
                  onClick={() => void revealPane(row.worktreeId, row.terminalId)}
                >
                  <span className="board-row__what">
                    <PaneGlyph agent={row.agent} />
                    <span className="board-row__label">{truncateName(row.label)}</span>
                  </span>
                  <span className="board-row__worktree">{row.worktreeName}</span>
                  <span className="board-row__evidence">{row.evidence ?? ''}</span>
                  <span className={needsYou ? `board-row__state board-row__state--${state}` : 'board-row__state'}>
                    {TONE_LABEL[state]}
                  </span>
                  <span className="board-row__since">{sinceLabel(row.quietFor)}</span>
                </button>
                {row.choices === undefined ? null : (
                  <AnswerButtons terminalId={row.terminalId} choices={row.choices} className="board-item__answers" />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PageFrame>
  )
}

const STAGES_BY_ATTENTION: readonly TaskStage[] = ['failed', 'asking', 'working', 'ready', 'stopped', 'done', 'landed']

function worktreeCount(rows: readonly { worktreeId: string }[]): number {
  return new Set(rows.map((row) => row.worktreeId)).size
}
