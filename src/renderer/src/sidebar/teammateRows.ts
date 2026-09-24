// A teammate's worktrees as the rows the sidebar already reads, built on `agentRows.ts` so
// one activity is never named two ways. Only time differs: silence crosses the wire as the
// owner's duration and the receiver adds what has elapsed since, trusting nobody's clock.

import { teammatesHeard, type PeerPane, type TeammatePresence, type TeammateWorktree } from '@shared/entities'
import { activityOf, paneNames, paneText, worktreeTone, type AgentRow, type DotTone } from './agentRows'
import { teammateStaleness, type TeammateStaleness } from './teammateStaleness'
import { worktreeDisplay } from './worktreeDisplay'

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
  /** Absent when it only repeats the name; see `worktreeDisplay`. */
  branch?: string
  state: TeammateWorktree['state']
  panes: TeammatePaneRow[]
  /** The collapsed row's dot. */
  tone: DotTone | null
  /** How old the whole picture is, in this machine's milliseconds. */
  heardAgoMs: number
  /**
   * Whether the link behind this row is connected right now: the unrounded truth, and the only
   * thing that may gate acting on a pane. `staleness` forgives a blink; this forgives nothing.
   */
  live: boolean
  /** How old this is and how to say so, or null while it is live. */
  staleness: TeammateStaleness | null
}

/** `now` is this machine's clock and `heardAt` a stamp it made itself; nothing here trusts a timestamp from the other end. */
export function teammateRows(
  worktrees: readonly TeammateWorktree[],
  now: number,
  /** The last line each watched pane said, by namespaced pane id. Only open panes have one: a teammate's pane does not stream until opened. */
  evidence: Readonly<Record<string, string | null>> = {}
): TeammateWorktreeRowModel[] {
  return worktrees.map((worktree) => {
    const display = worktreeDisplay(worktree)
    const heardAgoMs = Math.max(0, now - worktree.heardAt)
    // Named together, as the owner's own sidebar names them: twins are told apart by each other.
    const names = paneNames(worktree.panes, worktree)
    const panes = worktree.panes.map((pane, index) =>
      paneRow(pane, names[index] ?? pane.title, worktree.handle, heardAgoMs, evidence[pane.id] ?? null)
    )
    return {
      id: worktree.id,
      handle: worktree.handle,
      name: display.title,
      ...(display.branch === undefined ? {} : { branch: display.branch }),
      state: worktree.state,
      panes,
      tone: worktreeTone(panes),
      heardAgoMs,
      live: worktree.live,
      staleness: teammateStaleness({ live: worktree.live, heardAt: worktree.heardAt, handle: worktree.handle, now })
    }
  })
}

function paneRow(
  pane: PeerPane,
  label: string,
  handle: string,
  heardAgoMs: number,
  evidence: string | null
): TeammatePaneRow {
  return {
    terminalId: pane.id,
    agent: pane.agent,
    label,
    text: paneText(pane, label),
    activity: activityOf(pane),
    // The owner's measurement plus the time it has sat here: the only arithmetic that believes no other clock.
    quietFor: pane.quietForMs + heardAgoMs,
    // Null until somebody opens the pane; no byte of it has crossed the wire before then.
    evidence,
    handle,
    cols: pane.cols,
    rows: pane.rows
  }
}

/** The hover text for a teammate's worktree row; whose it is comes first. */
export function teammateTitle(row: TeammateWorktreeRowModel): string {
  const panes = `${row.panes.length} pane${row.panes.length === 1 ? '' : 's'}`
  const head = [row.name, `${row.handle}’s worktree on their machine`, row.branch, panes].filter(Boolean).join(' · ')
  return row.staleness ? `${head}\n${row.staleness.detail}` : head
}

/** Teammates on the roster there is no picture of. Not a row each: inventing a row for them would be inventing work. */
export function unheardTeammates(presence: TeammatePresence | undefined): string[] {
  // Nothing while the project is unread: a roster nobody has opened supports no claim.
  return (teammatesHeard(presence)?.teammates ?? [])
    .filter((teammate) => teammate.heardAt === null)
    .map((teammate) => teammate.handle)
}

/** The whole of it on hover, said as three facts rather than as a diagnosis. */
export function unheardTitle(handles: readonly string[]): string {
  const who = handles.join(', ')
  const verb = handles.length === 1 ? 'is' : 'are'
  return `${who} ${verb} on the roster · nothing heard yet, so no worktrees to show`
}
