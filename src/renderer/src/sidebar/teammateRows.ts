// A teammate's worktrees, turned into the rows the sidebar already knows how to
// read.
//
// Deliberately built on `agentRows.ts` rather than beside it. The four activity
// states, the phrases for them and the rule for naming a pane are the same four
// states, phrases and rule whether the PTY is on this machine or somebody
// else's — and two modules describing them is how an app ends up calling one of
// them two different things, on two rows, in one list.
//
// The one thing that is genuinely different is time. A teammate's silence
// crossed the wire as a duration measured by its owner, because two machines do
// not agree about what time it is. The receiver adds what has elapsed since it
// arrived, which is the only part of the number it is entitled to, and the
// result is honest at the cost of being a little behind — which is the right
// way round for a number whose job is to say something has been sitting there.

import type { PeerPane, TeammateWorktree } from '@shared/entities'
import { activityOf, paneLabel, worktreeActivity, type AgentActivity, type AgentRow } from './agentRows'

export type TeammatePaneRow = AgentRow & {
  /** Whose pane it is, so a row is never ambiguous about that. */
  handle: string
  /** The owner's pty size, for a watcher to letterbox to. */
  cols: number | undefined
  rows: number | undefined
}

export type TeammateWorktreeRowModel = {
  /** Already namespaced by the runtime; unique across every teammate. */
  id: string
  handle: string
  name: string
  branch: string
  state: TeammateWorktree['state']
  panes: TeammatePaneRow[]
  /** What the worktree as a whole is doing, for the collapsed row. */
  activity: AgentActivity | null
  /** How old the whole picture is, in this machine's milliseconds. */
  heardAgoMs: number
}

/**
 * `now` is this machine's clock and `heardAt` is a stamp it made itself, so
 * nothing here trusts a timestamp from the other end.
 */
export function teammateRows(
  worktrees: readonly TeammateWorktree[],
  now: number,
  /**
   * The last line each watched pane has said, keyed by the namespaced pane id.
   *
   * Only panes somebody has open have one, and that is the point: a teammate's
   * pane does not stream until it is opened, so a row that quoted one nobody is
   * watching would be quoting something this machine has never been sent.
   */
  evidence: Readonly<Record<string, string | null>> = {}
): TeammateWorktreeRowModel[] {
  return worktrees.map((worktree) => {
    const heardAgoMs = Math.max(0, now - worktree.heardAt)
    const panes = worktree.panes.map((pane) => paneRow(pane, worktree.handle, heardAgoMs, evidence[pane.id] ?? null))
    return {
      id: worktree.id,
      handle: worktree.handle,
      name: worktree.name,
      branch: worktree.branch,
      state: worktree.state,
      panes,
      activity: worktreeActivity(panes),
      heardAgoMs
    }
  })
}

function paneRow(pane: PeerPane, handle: string, heardAgoMs: number, evidence: string | null): TeammatePaneRow {
  return {
    terminalId: pane.id,
    agent: pane.agent,
    label: pane.agent ?? paneLabel(pane),
    activity: activityOf(pane),
    // The owner's measurement plus the time it has been sitting here. Adding
    // the two is the only arithmetic that does not involve believing somebody
    // else's clock.
    quietFor: pane.quietForMs + heardAgoMs,
    // Null until somebody opens the pane, because until then no byte of it has
    // crossed the wire and a quotation would be an invention.
    evidence,
    handle,
    cols: pane.cols,
    rows: pane.rows
  }
}

/**
 * The hover text for a teammate's worktree row.
 *
 * It says whose it is first, because that is the fact that changes what every
 * other fact on the row means.
 */
export function teammateTitle(row: TeammateWorktreeRowModel): string {
  const panes = `${row.panes.length} pane${row.panes.length === 1 ? '' : 's'}`
  return `${row.name} · ${row.handle}’s worktree on their machine · ${row.branch} · ${panes}`
}
