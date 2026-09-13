// What each agent in a worktree is doing, for the sidebar.
//
// This is the question the app exists to answer and did not: with five agents
// running, which of them needs you. Git chips cannot say — a worktree whose
// agent finished twenty minutes ago and one whose agent is mid-edit look
// identical through them.
//
// What is knowable here is deliberately narrower than what a reader might want.
// Teamree watches a PTY, not an agent's protocol, so there is no "thinking" and
// no "waiting for permission" — only whether bytes are still arriving, and how
// the process ended. Every state below is one of those two facts, and none of
// them is a guess dressed up as a reading.

import type { AgentKind, Terminal } from '@shared/entities'

export type AgentActivity =
  /** Output is still arriving. */
  | 'working'
  /** Running, but it has stopped saying things — which is what waiting looks like. */
  | 'quiet'
  /** Exited cleanly. */
  | 'done'
  /** Exited with a non-zero status, or on a signal. */
  | 'failed'

export type AgentRow = {
  terminalId: string
  /** The agent, when the pane runs one; absent for a plain shell. */
  agent: AgentKind | undefined
  /** What to call it: the agent's name, or the terminal's own title. */
  label: string
  activity: AgentActivity
  /** Milliseconds since output last arrived. */
  quietFor: number
}

export function activityOf(terminal: Terminal): AgentActivity {
  if (!terminal.running) return terminal.exitCode === 0 ? 'done' : 'failed'
  return terminal.busy ? 'working' : 'quiet'
}

/**
 * The rows for one worktree, in the order their panes were opened.
 *
 * Plain shells are included. A terminal someone left a build running in is as
 * much a thing that might want attention as an agent is, and hiding it would
 * make the count on the row disagree with what is actually open.
 */
export function agentRows(terminals: readonly Terminal[], worktreeId: string, now: number): AgentRow[] {
  return terminals
    .filter((terminal) => terminal.worktreeId === worktreeId)
    .map((terminal) => ({
      terminalId: terminal.id,
      agent: terminal.agent,
      label: terminal.agent ?? terminal.title,
      activity: activityOf(terminal),
      quietFor: Math.max(0, now - terminal.lastOutputAt)
    }))
}

/**
 * What the worktree as a whole is doing, for the collapsed row.
 *
 * Ordered by what would make someone look: anything failed outranks anything
 * working, because a failure is finished and wrong while work in progress is
 * merely unfinished.
 */
export function worktreeActivity(rows: readonly AgentRow[]): AgentActivity | null {
  if (rows.length === 0) return null
  if (rows.some((row) => row.activity === 'failed')) return 'failed'
  if (rows.some((row) => row.activity === 'working')) return 'working'
  if (rows.some((row) => row.activity === 'quiet')) return 'quiet'
  return 'done'
}

/**
 * How long since anything happened, in the shortest form that is still true.
 *
 * Rounded down on purpose: "4m" while the fifth minute is running reads as
 * less stale than it is, which is the wrong way round for a number whose whole
 * job is to tell you something has been sitting there.
 */
export function sinceLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 10) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
