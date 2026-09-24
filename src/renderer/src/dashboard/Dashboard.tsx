// Every pane in the window, flat, ordered by what needs a person. It takes the main area: it is read
// across worktrees and every row is a way out. PTYs live in the runtime, so panes keep running.

import { useEffect, useMemo, useRef, useState } from 'react'

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
import { dashboardRows, toneCounts } from './dashboardRows'

export function Dashboard(): React.JSX.Element {
  const terminals = useWorkspaceStore((state) => state.terminals)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const layouts = useWorkspaceStore((state) => state.layouts)
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const toggleDashboard = useWorkspaceStore((state) => state.toggleDashboard)

  const now = useNow()
  const paneList = useMemo(() => Object.values(terminals), [terminals])
  const evidence = usePaneEvidence(paneList, terminals)
  const rows = useMemo(
    () => dashboardRows({ terminals: paneList, worktrees, projects, layouts, now, evidence }),
    [paneList, worktrees, projects, layouts, now, evidence]
  )
  const counts = useMemo(() => toneCounts(rows), [rows])

  // A state nothing is in any more has no filter to press, so it filters nothing.
  const [onlyTone, setOnlyTone] = useState<DotTone | null>(null)
  const tone = onlyTone !== null && counts[onlyTone] > 0 ? onlyTone : null

  // "Said something since I last looked"; not remembered across launches, or the board would hide rows.
  const [unreadOnly, setUnreadOnly] = useState(false)
  const unread = useUnreadPanes()
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
  useEffect(() => {
    if (landed.current || shown.length === 0) return
    const first = list.current?.querySelector('button')
    if (!first) return
    landed.current = true
    first.focus()
  }, [shown.length])

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
        shown.length === 0
          ? 'No panes'
          : `${shown.length} pane${shown.length === 1 ? '' : 's'} across ${worktreeCount(shown)} worktree${
              worktreeCount(shown) === 1 ? '' : 's'
            }`
      }
      actions={
        <>
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
      {shown.length === 0 ? (
        <div className="placeholder">
          <h2 className="placeholder__title">{unreadOnly && rows.length > 0 ? 'Nothing unread' : 'Nothing running'}</h2>
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

function worktreeCount(rows: readonly { worktreeId: string }[]): number {
  return new Set(rows.map((row) => row.worktreeId)).size
}
