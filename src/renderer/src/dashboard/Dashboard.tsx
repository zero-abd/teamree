// Every pane in the window, flat, ordered by what needs a person.
//
// It takes the whole main area rather than sitting beside the panes as a
// drawer. Two reasons, both about what this view is for: it is read across all
// the worktrees, so binding it to the tab that happens to be open would be the
// wrong frame; and every row in it is a way of leaving it, so it is somewhere
// you pass through rather than something to keep open beside your work. A
// permanent drawer would also spend terminal width on a question that is asked
// in bursts.
//
// Nothing here is unmounted that was costing anything: the PTYs live in the
// runtime, so a pane keeps running and keeps its scrollback while this is up.

import { useEffect, useMemo, useRef } from 'react'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { modalOnScreen } from '../dialogs/modalLayer'
import { ACTIVITY_LABEL, ACTIVITY_NOUN, sinceLabel } from '../sidebar/agentRows'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { ACTIVITIES_BY_ATTENTION, activityCounts, dashboardRows } from './dashboardRows'

export function Dashboard({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
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
  const counts = useMemo(() => activityCounts(rows), [rows])

  // Escape is what every reader tries first on a view they opened to look at
  // something. Capture, for the same reason the chords are captured: a focused
  // pane must not eat it first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Anything modal on top owns Escape: dismissing the palette and this view
      // with one press would take away more than the reader asked for.
      //
      // `modalOnScreen` rather than `dialog`, and that is a fix rather than a
      // tidy-up. A question about a teammate's keystrokes is not in `dialog` —
      // nobody in this window opened it — and it is the one modal here that
      // refuses to be dismissed, so with the old check Escape went straight
      // past it and closed the board underneath a scrim the owner could not
      // see through and could not get out of without answering. The window's
      // own key handler had already been taught this; see `modalLayer.ts`,
      // which exists because each surface learned only the half it was written
      // beside.
      if (modalOnScreen(useWorkspaceStore.getState())) return
      event.preventDefault()
      toggleDashboard()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleDashboard])

  // Opened from a chord, so the keyboard has to land somewhere it can act:
  // the first row is both the answer to "who needs me" and the way to go there.
  //
  // Keyed on whether there is a row to land on rather than on mount alone,
  // because at the moment this mounts there very often is not: the board is
  // reachable before `bootstrap` has answered, and the empty state renders no
  // list at all — so a mount-only effect focused nothing and the rows that
  // arrived a moment later were unreachable from the keyboard. The ref guard is
  // what keeps it to once: `rows` is rebuilt on every tick of the clock behind
  // the "quiet for" column, and a focus call on each of those would drag the
  // focus back off whatever the reader had moved it to, once a second.
  const list = useRef<HTMLUListElement>(null)
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || rows.length === 0) return
    const first = list.current?.querySelector('button')
    if (!first) return
    landed.current = true
    first.focus()
  }, [rows.length])

  return (
    <main className="workspace board" aria-label="Every pane">
      <header className="board__head">
        <div className="board__identity">
          <h1 className="board__title">All panes</h1>
          <p className="board__lede">
            {rows.length === 0
              ? 'No panes anywhere yet.'
              : `${rows.length} pane${rows.length === 1 ? '' : 's'} across ${worktreeCount(rows)} worktree${
                  worktreeCount(rows) === 1 ? '' : 's'
                }`}
          </p>
        </div>

        <ul className="board__counts" aria-label="Panes by state">
          {ACTIVITIES_BY_ATTENTION.map((activity) => (
            <li
              key={activity}
              className={`board-count${counts[activity] === 0 ? ' board-count--zero' : ''}`}
              title={ACTIVITY_LABEL[activity]}
            >
              <span className={`activity activity--${activity}`} aria-hidden="true" />
              <span className="board-count__number">{counts[activity]}</span>
              <span className="board-count__label">{ACTIVITY_NOUN[activity]}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="board__close"
          title={`Back to the panes · ${shortcutHint('open-dashboard', modifier)}`}
          aria-label="Back to the panes"
          onClick={toggleDashboard}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </header>

      {rows.length === 0 ? (
        <div className="placeholder">
          <h2 className="placeholder__title">Nothing running</h2>
          <p className="placeholder__body">
            Open a terminal with <kbd>{shortcutHint('new-terminal', modifier)}</kbd>.
          </p>
        </div>
      ) : (
        <ul className="board__list" ref={list}>
          {rows.map((row) => (
            <li key={row.terminalId}>
              <button
                type="button"
                className={`board-row board-row--${row.activity}`}
                title={`${row.label} in ${row.worktreeName} · ${ACTIVITY_LABEL[row.activity]} · last output ${sinceLabel(
                  row.quietFor
                )} ago`}
                onClick={() => void revealPane(row.worktreeId, row.terminalId)}
              >
                <span className={`activity activity--${row.activity}`} aria-hidden="true" />
                <span className="board-row__what">
                  <span className="board-row__label">{row.label}</span>
                  {/* An agent pane is named by its agent, so only a shell needs saying. */}
                  {row.agent ? null : <span className="board-row__kind">shell</span>}
                </span>
                <span className="board-row__state">{ACTIVITY_NOUN[row.activity]}</span>
                <span className="board-row__where">
                  <span className="board-row__worktree">{row.worktreeName}</span>
                  <span className="board-row__branch">{row.branch}</span>
                </span>
                <span className="board-row__project">{row.projectName}</span>
                <span className="board-row__since">{sinceLabel(row.quietFor)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function worktreeCount(rows: readonly { worktreeId: string }[]): number {
  return new Set(rows.map((row) => row.worktreeId)).size
}
