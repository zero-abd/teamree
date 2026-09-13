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

import type { PeerPane, TeammatePresence, TeammateWorktree } from '@shared/entities'
import { activityOf, paneLabel, worktreeActivity, type AgentActivity, type AgentRow } from './agentRows'
import { teammateStaleness, type TeammateStaleness } from './teammateStaleness'

export type TeammatePaneRow = AgentRow & {
  /** Whose pane it is, so a row is never ambiguous about that. */
  handle: string
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
  /**
   * Whether the link behind this row is connected right now.
   *
   * The unrounded truth, and the only thing that may ever gate acting on a
   * pane. `staleness` below is what a reader is shown and it forgives a blink;
   * this forgives nothing.
   */
  live: boolean
  /** How old this is and how to say so, or null while it is live. */
  staleness: TeammateStaleness | null
}

/**
 * `now` is this machine's clock and `heardAt` is a stamp it made itself, so
 * nothing here trusts a timestamp from the other end.
 */
export function teammateRows(worktrees: readonly TeammateWorktree[], now: number): TeammateWorktreeRowModel[] {
  return worktrees.map((worktree) => {
    const heardAgoMs = Math.max(0, now - worktree.heardAt)
    const panes = worktree.panes.map((pane) => paneRow(pane, worktree.handle, heardAgoMs))
    return {
      id: worktree.id,
      handle: worktree.handle,
      name: worktree.name,
      branch: worktree.branch,
      state: worktree.state,
      panes,
      activity: worktreeActivity(panes),
      heardAgoMs,
      live: worktree.live,
      staleness: teammateStaleness({ live: worktree.live, heardAt: worktree.heardAt, handle: worktree.handle, now })
    }
  })
}

function paneRow(pane: PeerPane, handle: string, heardAgoMs: number): TeammatePaneRow {
  return {
    terminalId: pane.id,
    agent: pane.agent,
    label: pane.agent ?? paneLabel(pane),
    activity: activityOf(pane),
    // The owner's measurement plus the time it has been sitting here. Adding
    // the two is the only arithmetic that does not involve believing somebody
    // else's clock.
    quietFor: pane.quietForMs + heardAgoMs,
    // Milestone C is what makes this anything but null. A teammate's pane does
    // not stream, so there is no line it has printed to quote — and quoting an
    // empty one would read as an answer.
    evidence: null,
    handle
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
  const head = `${row.name} · ${row.handle}’s worktree on their machine · ${row.branch} · ${panes}`
  return row.staleness ? `${head}\n${row.staleness.detail}` : head
}

/**
 * Teammates on the roster there is no picture of at all.
 *
 * Deliberately not a row each. A colleague whose app has never been up while
 * yours was has no worktrees to show and, as far as this machine knows, may
 * have none — inventing a row for them would be inventing work, which is the
 * mirror of the mistake this milestone exists to prevent. One line saying they
 * are on the roster and unheard is the whole of what is true.
 */
export function unheardTeammates(presence: TeammatePresence | undefined): string[] {
  return (presence?.teammates ?? []).filter((teammate) => teammate.heardAt === null).map((teammate) => teammate.handle)
}

/** The whole of it on hover, said as three facts rather than as a diagnosis. */
export function unheardTitle(handles: readonly string[]): string {
  const who = handles.join(', ')
  const verb = handles.length === 1 ? 'is' : 'are'
  return (
    `${who} ${verb} on this project’s roster. Nothing has been heard from them, ` +
    'so there is no picture of their worktrees here — not even an old one.'
  )
}
