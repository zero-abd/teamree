// One of a teammate's worktrees, under the same project as your own.
//
// Two things a reader must never be wrong about, and both are structural rather
// than decorative:
//
// **Whose it is.** The handle is on the row itself, not only in a tooltip, and
// the row carries a class the stylesheet indents and tints. A reader glancing
// down the list has to be able to see where their checkouts stop without
// reading a word.
//
// **That it is not theirs to act on.** There is no remove button and no retry:
// the worktree row is a `<div>` rather than a button with a disabled attribute,
// because a disabled control is a thing that would work if something were
// different and this is a thing that will not.
//
// The panes underneath it are the one exception, and only in one direction. A
// pane can be opened for *reading*, so it is a real button and says "watch" —
// and what it opens is a viewer that cannot be typed into, rather than a pane
// of your own that happens to be somebody else's.
//
// **Whether this is a live view or a remembered one.** A row whose teammate is
// away stays exactly where it was — a worktree disappearing reads as a worktree
// deleted — and says how old it is, in the same words and the same rounding
// every other age in this sidebar uses.

import { ACTIVITY_LABEL, sinceLabel } from './agentRows'
import { teammateTitle, type TeammatePaneRow, type TeammateWorktreeRowModel } from './teammateRows'

type TeammateWorktreeRowProps = {
  row: TeammateWorktreeRowModel
  /** The pane this window currently has open for reading, if any. */
  watchingPaneId: string | null
  onWatch: (pane: TeammatePaneRow) => void
}

export function TeammateWorktreeRow({ row, watchingPaneId, onWatch }: TeammateWorktreeRowProps): React.JSX.Element {
  return (
    <li className={`worktree worktree--teammate worktree--${row.state}${row.staleness ? ' worktree--stale' : ''}`}>
      <div className="worktree__row worktree__row--teammate" title={teammateTitle(row)}>
        <div className="worktree__open worktree__open--teammate">
          <span className="worktree__title">
            <span className="worktree__name">{row.name}</span>
            {row.activity ? (
              <span
                className={`activity activity--${row.activity}`}
                title={ACTIVITY_LABEL[row.activity]}
                aria-label={ACTIVITY_LABEL[row.activity]}
              />
            ) : null}
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
          {row.panes.map((pane) => (
            <li key={pane.terminalId}>
              <button
                type="button"
                className={`pane-row pane-row--teammate pane-row--watchable${
                  pane.terminalId === watchingPaneId ? ' pane-row--watching' : ''
                }`}
                title={`Watch ${row.handle}’s ${pane.label} · ${ACTIVITY_LABEL[pane.activity]} · reading only`}
                aria-pressed={pane.terminalId === watchingPaneId}
                onClick={() => onWatch(pane)}
              >
                <span className="pane-row__head">
                  <span className={`activity activity--${pane.activity}`} aria-hidden="true" />
                  <span className="pane-row__label">{pane.label}</span>
                  <span className="pane-row__since">{sinceLabel(pane.quietFor)}</span>
                </span>
                {/* Only ever a line the pane actually printed while somebody had
                    it open, which is why it is absent on every other row. */}
                {pane.evidence ? <span className="pane-row__evidence">{pane.evidence}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
