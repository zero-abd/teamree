// One of a teammate's worktrees, under their group in the same project as your own. Their face is on
// the row and the row is a `<div>`, not a disabled button: it only opens its first pane. Panes can be
// watched, and an asking one answered through its owner's consent; an away teammate's row stays, dimmed.
// A finished one offers Review, and its right-click menu Review and Watch.

import { useState } from 'react'
import type { TaskStage } from '@shared/tasks'
import type { ScreenChoice } from '@shared/screenOpinion'
import { dotClass, dotTone, TONE_LABEL, truncateName } from './agentRows'
import { AllowOpen } from './AnswerButtons'
import { PaneSince } from './PaneRows'
import { teammateTitle, type TeammatePaneRow, type TeammateWorktreeRowModel } from './teammateRows'
import { PaneGlyph } from '../agents/glyphs'
import { Avatar } from '../teamwork/Avatar'
import type { TheirOverlap } from './teamGlance'
import { paneRowSpeech } from './rowSpeech'
import { anchorAtPointer, RowMenu, type RowMenuAnchor, type RowMenuItem } from './RowMenu'
import { Button } from '../ui/Button'

type TeammateWorktreeRowProps = {
  row: TeammateWorktreeRowModel
  /** The panes of this project the window has open; they take slots in the workspace. */
  watchingPaneIds: readonly string[]
  onWatch: (pane: TeammatePaneRow) => void
  /** An answer to an asking pane, which their machine holds for their consent. */
  onAnswer: (pane: TeammatePaneRow, choice: ScreenChoice) => void
  /** Your worktrees changing the same files; pressing it opens yours. */
  overlap?: TheirOverlap & { onOpen: () => void }
  /** Opens its diff read-only; absent offers no review. */
  onReview?: () => void
}

/** Stages at which a task's agent has stopped with something to look at. */
const FINISHED: ReadonlySet<TaskStage> = new Set<TaskStage>(['ready', 'done', 'failed'])

export function TeammateWorktreeRow({
  row,
  watchingPaneIds,
  onWatch,
  onAnswer,
  overlap,
  onReview
}: TeammateWorktreeRowProps): React.JSX.Element {
  const { tone } = row
  const first = row.panes[0]
  // As on your own rows: Tab from a focused pane row reaches its answers, and the tree stays one Tab stop otherwise.
  const [focused, setFocused] = useState<string | null>(null)
  // One under the teammate's group.
  const level = 3 + row.depth
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const items: RowMenuItem[] = [
    ...(onReview === undefined ? [] : [{ label: 'Review', onChoose: onReview }]),
    ...(first === undefined ? [] : [{ label: 'Watch', onChoose: () => onWatch(first) }])
  ]
  return (
    <li
      className={`worktree worktree--teammate worktree--${row.state}${tone === 'waiting' ? ' worktree--asking' : ''}${
        row.staleness ? ' worktree--stale' : ''
      }`}
      role="none"
      style={row.depth > 0 ? ({ '--depth': row.depth } as React.CSSProperties) : undefined}
    >
      <div
        className="worktree__row worktree__row--teammate"
        data-tip={teammateTitle(row)}
        onContextMenu={(event) => {
          if (items.length === 0) return
          event.preventDefault()
          setMenuAt(anchorAtPointer(event.clientX, event.clientY))
        }}
      >
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
            {tone ? (
              <span className={dotClass(tone)} data-tip={TONE_LABEL[tone]} aria-label={TONE_LABEL[tone]} />
            ) : null}
          </span>
          <span className="worktree__meta">
            {row.stage === undefined ? null : <span className="worktree__stage">{row.word}</span>}
            {row.report === undefined ? null : <span className="worktree__report">{row.report}</span>}
            {row.branch === undefined ? null : <span className="worktree__branch">{row.branch}</span>}
            {overlap === undefined ? null : (
              <button
                type="button"
                className={`chip overlap overlap--${overlap.tone} overlap--open worktree__their-overlap`}
                tabIndex={-1}
                data-tip={overlap.title}
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
        {onReview !== undefined && row.stage !== undefined && FINISHED.has(row.stage) ? (
          <Button size="sm" variant="ghost" className="worktree__review" tabIndex={-1} onClick={onReview}>
            Review
          </Button>
        ) : null}
      </div>
      {menuAt === null ? null : (
        <RowMenu label={`Actions for ${row.name}`} items={items} anchor={menuAt} onClose={() => setMenuAt(null)} />
      )}

      {row.panes.length > 0 ? (
        <ul className="panes panes--teammate" role="group">
          {row.panes.map((pane) => {
            const watching = watchingPaneIds.includes(pane.terminalId)
            return (
              <li
                key={pane.terminalId}
                role="none"
                className={`pane-item${pane.choices === undefined ? '' : ' pane-item--asking'}`}
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
                  data-tip={
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
                    {pane.choices === undefined ? (
                      <PaneSince tone={dotTone(pane.activity, pane.agent)} quietFor={pane.quietFor} />
                    ) : null}
                  </span>
                </button>
                {pane.choices === undefined ? null : (
                  <AllowOpen
                    terminalId={pane.terminalId}
                    choices={pane.choices}
                    onOpen={() => {
                      if (!watching) onWatch(pane)
                    }}
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
