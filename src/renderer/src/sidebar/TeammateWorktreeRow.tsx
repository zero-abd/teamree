// One of a teammate's worktrees, under the same project as your own. The
// handle is on the row and the row is a `<div>`, not a disabled button: it will
// not act. Panes can be watched; an away teammate's row stays put and says how old it is.

import { dotClass, dotTone, sinceLabel, TONE_LABEL, truncateName } from './agentRows'
import { teammateTitle, type TeammatePaneRow, type TeammateWorktreeRowModel } from './teammateRows'
import { PaneGlyph } from '../agents/glyphs'

type TeammateWorktreeRowProps = {
  row: TeammateWorktreeRowModel
  /** The panes of this project the window has open; they take slots in the workspace. */
  watchingPaneIds: readonly string[]
  onWatch: (pane: TeammatePaneRow) => void
}

export function TeammateWorktreeRow({ row, watchingPaneIds, onWatch }: TeammateWorktreeRowProps): React.JSX.Element {
  const { tone } = row
  return (
    <li className={`worktree worktree--teammate worktree--${row.state}${row.staleness ? ' worktree--stale' : ''}`}>
      <div className="worktree__row worktree__row--teammate" title={teammateTitle(row)}>
        <div className="worktree__open worktree__open--teammate">
          <span className="worktree__title">
            <span className="worktree__name">{row.name}</span>
            {tone ? <span className={dotClass(tone)} title={TONE_LABEL[tone]} aria-label={TONE_LABEL[tone]} /> : null}
          </span>
          <span className="worktree__meta">
            {/* First on the line, because it is the fact that changes what
                every other fact on the row means. */}
            <span className="worktree__owner">{row.handle}</span>
            <span className="worktree__branch">{row.branch}</span>
            {/* The age, never the bare word "offline": what is known is how old
                this picture is, and the sentence behind it says their machine
                is away rather than anything at all about the worktree. The
                badge names which age it is, because the number is the age of
                the picture and not of the absence, and the two are not the
                same for a teammate whose worktrees had been static for hours
                before their machine went. */}
            {row.staleness ? (
              <span className="worktree__stale" title={row.staleness.detail} aria-label={row.staleness.detail}>
                {row.staleness.badge}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {row.panes.length > 0 ? (
        <ul className="panes panes--teammate">
          {row.panes.map((pane) => {
            const watching = watchingPaneIds.includes(pane.terminalId)
            return (
              <li key={pane.terminalId}>
                <button
                  type="button"
                  className={`pane-row pane-row--teammate pane-row--watchable${watching ? ' pane-row--watching' : ''}`}
                  title={
                    watching
                      ? `Stop watching ${row.handle}’s ${pane.label}`
                      : `Watch ${row.handle}’s ${pane.label} · ${TONE_LABEL[dotTone(pane.activity, pane.agent)]} · reading only`
                  }
                  aria-pressed={watching}
                  onClick={() => onWatch(pane)}
                >
                  <span className="pane-row__head">
                    <span className={dotClass(dotTone(pane.activity, pane.agent))} aria-hidden="true" />
                    <PaneGlyph agent={pane.agent} />
                    <span className="pane-row__label">{truncateName(pane.text)}</span>
                    <span className="pane-row__since">{sinceLabel(pane.quietFor)}</span>
                  </span>
                  {/* Only ever a line the pane actually printed while somebody had
                    it open, which is why it is absent on every other row. */}
                  {pane.evidence ? <span className="pane-row__evidence">{pane.evidence}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}
