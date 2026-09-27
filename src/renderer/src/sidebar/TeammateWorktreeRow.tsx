// One of a teammate's worktrees, under their group in the same project as your own. Their face is on
// the row and the row is a `<div>`, not a disabled button: it only opens its first pane. Panes can be
// watched, and an asking one answered through its owner's consent; an away teammate's row stays, dimmed.

import { useState } from 'react'
import type { ScreenChoice } from '@shared/screenOpinion'
import { dotClass, dotTone, TONE_LABEL, truncateName } from './agentRows'
import { AnswerButtons } from './AnswerButtons'
import { PaneSince } from './PaneRows'
import { teammateTitle, type TeammatePaneRow, type TeammateWorktreeRowModel } from './teammateRows'
import { PaneGlyph } from '../agents/glyphs'
import { Avatar } from '../teamwork/Avatar'
import type { TheirOverlap } from './teamGlance'
import { paneRowSpeech } from './rowSpeech'

type TeammateWorktreeRowProps = {
  row: TeammateWorktreeRowModel
  /** The panes of this project the window has open; they take slots in the workspace. */
  watchingPaneIds: readonly string[]
  onWatch: (pane: TeammatePaneRow) => void
  /** An answer to an asking pane, which their machine holds for their consent. */
  onAnswer: (pane: TeammatePaneRow, choice: ScreenChoice) => void
  /** Your worktrees changing the same files; pressing it opens yours. */
  overlap?: TheirOverlap & { onOpen: () => void }
}

export function TeammateWorktreeRow({
  row,
  watchingPaneIds,
  onWatch,
  onAnswer,
  overlap
}: TeammateWorktreeRowProps): React.JSX.Element {
  const { tone } = row
  const first = row.panes[0]
  // As on your own rows: Tab from a focused pane row reaches its answers, and the tree stays one Tab stop otherwise.
  const [focused, setFocused] = useState<string | null>(null)
  // One under the teammate's group.
  const level = 3 + row.depth
  return (
    <li
      className={`worktree worktree--teammate worktree--${row.state}${row.staleness ? ' worktree--stale' : ''}`}
      role="none"
      style={row.depth > 0 ? ({ '--depth': row.depth } as React.CSSProperties) : undefined}
    >
      <div className="worktree__row worktree__row--teammate" title={teammateTitle(row)}>
        {/* A row of the sidebar tree, focusable so the arrows pass through it to the panes it holds. */}
        <div
          className="worktree__open worktree__open--teammate"
          role="treeitem"
          aria-level={level}
          aria-expanded={row.panes.length > 0 ? true : undefined}
          tabIndex={-1}
          onClick={() => {
            if (first !== undefined && !watchingPaneIds.includes(first.terminalId)) onWatch(first)
          }}
        >
          <span className="worktree__title">
            <Avatar handle={row.handle} size="xs" decorative />
            <span className="worktree__name">{row.name}</span>
            {tone ? <span className={dotClass(tone)} title={TONE_LABEL[tone]} aria-label={TONE_LABEL[tone]} /> : null}
          </span>
          <span className="worktree__meta">
            {row.stage === undefined ? null : <span className="worktree__stage">{row.stage}</span>}
            {row.report === undefined ? null : <span className="worktree__report">{row.report}</span>}
            {row.branch === undefined ? null : <span className="worktree__branch">{row.branch}</span>}
            {overlap === undefined ? null : (
              <button
                type="button"
                className={`chip overlap overlap--${overlap.tone} overlap--open worktree__their-overlap`}
                tabIndex={-1}
                title={overlap.title}
                aria-label={`Overlaps ${overlap.label}`}
                onClick={(event) => {
                  event.stopPropagation()
                  overlap.onOpen()
                }}
              >
                {`⚠ ${overlap.label}`}
              </button>
            )}
          </span>
        </div>
      </div>

      {row.panes.length > 0 ? (
        <ul className="panes panes--teammate" role="group">
          {row.panes.map((pane) => {
            const watching = watchingPaneIds.includes(pane.terminalId)
            return (
              <li
                key={pane.terminalId}
                role="none"
                className="pane-item"
                onFocus={() => setFocused(pane.terminalId)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
                }}
              >
                <button
                  type="button"
                  role="treeitem"
                  aria-level={level + 1}
                  data-teammate-pane={pane.terminalId}
                  tabIndex={-1}
                  className={`pane-row pane-row--teammate pane-row--watchable${watching ? ' pane-row--watching' : ''}`}
                  title={
                    watching
                      ? `Stop watching ${row.handle}’s ${pane.label}`
                      : `Watch ${row.handle}’s ${pane.label} · ${TONE_LABEL[dotTone(pane.activity, pane.agent)]} · reading only`
                  }
                  aria-selected={watching}
                  aria-label={paneRowSpeech({ ...pane, label: `${row.handle}’s ${pane.label}` })}
                  onClick={() => onWatch(pane)}
                >
                  <span className="pane-row__head">
                    <PaneGlyph agent={pane.agent} decorative />
                    <span className="pane-row__label">{truncateName(pane.text)}</span>
                    {/* Only ever a line the pane printed while somebody had it open. */}
                    {pane.evidence ? <span className="pane-row__evidence">{pane.evidence}</span> : null}
                    <PaneSince tone={dotTone(pane.activity, pane.agent)} quietFor={pane.quietFor} />
                  </span>
                </button>
                {pane.choices === undefined ? null : (
                  <AnswerButtons
                    terminalId={pane.terminalId}
                    choices={pane.choices}
                    className="pane-item__answers"
                    tabbable={focused === pane.terminalId}
                    onChoose={(choice) => onAnswer(pane, choice)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}
