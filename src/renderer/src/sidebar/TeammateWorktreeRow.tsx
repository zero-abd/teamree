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
// **That it is not theirs to act on.** There is no remove button, no retry, and
// nothing to open: this is not a button with a disabled attribute, it is a
// `<div>`, because a disabled button is a thing that would work if something
// were different and this is a thing that will not. Milestone C makes a pane
// openable for reading; until then the honest affordance is none.
//
// **Whether this is a live view or a remembered one.** A row whose teammate is
// away stays exactly where it was — a worktree disappearing reads as a worktree
// deleted — and says how old it is, in the same words and the same rounding
// every other age in this sidebar uses.

import { ACTIVITY_LABEL, sinceLabel } from './agentRows'
import { teammateTitle, type TeammateWorktreeRowModel } from './teammateRows'

export function TeammateWorktreeRow({ row }: { row: TeammateWorktreeRowModel }): React.JSX.Element {
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
                is away rather than anything at all about the worktree. */}
            {row.staleness ? (
              <span className="worktree__stale" title={row.staleness.detail} aria-label={row.staleness.detail}>
                {`away · ${row.staleness.age}`}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {row.panes.length > 0 ? (
        <ul className="panes panes--teammate">
          {row.panes.map((pane) => (
            <li key={pane.terminalId}>
              <div className="pane-row pane-row--teammate" title={`${pane.label} · ${ACTIVITY_LABEL[pane.activity]}`}>
                <span className="pane-row__head">
                  <span className={`activity activity--${pane.activity}`} aria-hidden="true" />
                  <span className="pane-row__label">{pane.label}</span>
                  <span className="pane-row__since">{sinceLabel(pane.quietFor)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
