// What is worth writing down about a terminal, and what to do with it on the
// way back up. The rule is in `restoreLaunch`: a stored command is re-issued
// only when it resumes something; anything else comes back as a plain shell, a Run pane as ended.

import type { RunKind } from '../../shared/entities'
import type { StoppedFor } from '../../shared/paneRestore'
import type { AgentKind } from './agent-command'
import { carriesSelector, restartSessionCommand, resumeSessionCommand } from './agent-command'
import { conversationOnDisk, type ConversationEvidence, type ConversationQuestion } from './agent-conversations'
import type { PanePlace } from './pane-tree'
import { noConversationMark } from './scrollbackRecord'

/** One terminal, as much of it as outlives the process that ran it. */
export type TerminalRecord = {
  /** Kept across the restart: durable pane layouts point at terminals by id. */
  id: string
  worktreeId: string
  cwd: string
  shell: string
  /** The command as it was launched, already carrying any id we pinned. */
  command?: string
  /** Which agent that command runs, when it runs one we know how to resume. */
  agent?: AgentKind
  /** What the pane is called, when somebody has said — a rename, or the task it was started for. */
  label?: string
  /** The session id we pinned at launch, when the agent let us choose one. */
  agentSessionId?: string
  /**
   * Whether anybody ever typed into this pane: the second-best guess at whether
   * there is a conversation to resume, used only where the agent's own store
   * cannot answer. A keystroke at Claude Code's trust gate is not a conversation.
   * Not output: every agent prints a banner. Only counts writes the window says
   * were by hand (`handsHere.ts`): the emulator's device-query answers are not.
   * Three values: absent is *unknown* — a record from before this field existed —
   * and unknown tries the resume, since a failed resume writes `false` on its way out.
   */
  typed?: boolean
  /** Its agent was handed the worktree's task at launch; the conversation it began is not started again. */
  prompted?: boolean
  /** See `Terminal.ordinal`: kept so an unnamed pane keeps its number across a restart. */
  ordinal?: number
  /** Which Run button started it; see `Terminal.run`. */
  run?: RunKind
  /** How the run or agent ended, when it ended before the app quit, and when. */
  exitCode?: number
  endedAt?: number
  cols: number
  rows: number
  createdAt: number
}

/** A closed pane as kept for `terminal.reopen`: its record, its number, and what it sat beside. */
export type ClosedTerminalRecord = {
  record: TerminalRecord
  ordinal?: number
  closedAt: number
  place?: PanePlace
}

export type RestoreLaunch = {
  /** The command to run, or undefined for an ordinary interactive shell. */
  command?: string
  /** True when that command picks a conversation back up. */
  resumed: boolean
  /**
   * Set when the pane is starting the agent over under a new id: what the
   * record has to become, so the next launch resumes this run.
   */
  repinned?: { command: string; agentSessionId?: string }
  /**
   * What to run in this pane if the resume above is refused. Absent when there
   * is nothing honest to fall back to: a command that cannot be modelled, or a
   * session the user named themselves (overwriting that loses their only trace).
   */
  fallback?: { command: string; agentSessionId?: string }
  /** A line for the pane to print first, when this launch is not the one the record asked for. */
  note?: string
  /** The agent is left stopped, and why; starting over is the owner's call. The end block says it, not the record. */
  stopped?: StoppedFor
}

/** An agent pane left stopped: it runs nothing but ending as it did, so it comes back ended with its record above. */
export function stoppedLaunch(reason: StoppedFor, exitCode = 0): RestoreLaunch {
  return { command: `exit ${exitCode}`, resumed: false, stopped: reason }
}

/** An agent's exit that is a failure: not a clean exit, and not ^C. */
export function agentFailed(exitCode: number | undefined): exitCode is number {
  return exitCode !== undefined && exitCode !== 0 && exitCode !== INTERRUPTED
}

/** ^C's exit status. */
const INTERRUPTED = 130

/**
 * How to bring one recorded terminal back. A command is re-issued only when it
 * resumes an agent conversation; `npm run deploy` is not re-run because the app
 * restarted. An agent pane with no conversation in the agent's own store is left
 * stopped when it was ever spoken to, and started over under a new id only when
 * it never was. `conversation` is a parameter so tests need no disk.
 */
export function restoreLaunch(
  record: TerminalRecord,
  conversation: (question: ConversationQuestion) => ConversationEvidence = conversationOnDisk
): RestoreLaunch {
  if (record.command === undefined || record.agent === undefined) return { resumed: false }

  // A session named on the command line with no pinned id of ours behind it was
  // chosen by hand: re-issued exactly as written, never rewritten around our own.
  if (record.agentSessionId === undefined && carriesSelector(record.command, record.agent)) {
    return { command: record.command, resumed: true }
  }

  const evidence = conversation({
    agent: record.agent,
    cwd: record.cwd,
    ...(record.agentSessionId === undefined ? {} : { agentSessionId: record.agentSessionId })
  })

  // Typed into, handed its task, or a record too old to say: absent `typed` is unknown, not no.
  const spoken = record.typed !== false || record.prompted === true
  // Evidence first, in both directions: the store is what the resume will read.
  if (evidence === 'absent' || (evidence === 'unknown' && !spoken)) {
    // A fresh start would begin again what was already begun: the task done twice.
    if (spoken) return stoppedLaunch('no-conversation')
    const restart = restartSessionCommand(record.command, record.agent)
    // Could not be modelled (a pipeline, an unclosed quote): re-issuing would
    // leave a dead session id on the line and a different one in the record.
    if (restart === null) return { resumed: false }
    // The note only for `absent`: "no conversation in the store" is news the
    // owner cannot get any other way; an empty pane shows itself.
    return {
      command: restart.command,
      resumed: false,
      repinned: restart,
      ...(evidence === 'absent' ? { note: noConversationMark(record.agent) } : {})
    }
  }

  const resume = resumeSessionCommand(record.command, record.agent, record.agentSessionId ?? null)
  // The agent offers no way back at all.
  if (resume === null) return { resumed: false }
  const fallback = restartSessionCommand(record.command, record.agent)
  return { command: resume, resumed: true, ...(fallback === null ? {} : { fallback }) }
}

/** The exit a run still going at the quit is recorded with: the hang-up `killProcessTree` sends. */
export const HUNG_UP = 129

/** What a restored Run pane runs: nothing but ending the way its run did, so Run Again has its pane back. */
export function endedRunCommand(record: TerminalRecord): string {
  return `exit ${record.exitCode ?? HUNG_UP}`
}

/**
 * Records worth restoring, oldest first; a worktree that is gone takes its terminals with it.
 * A same-millisecond tie keeps the order of `shown` (pane ids as laid out), then stored order.
 */
export function restorableRecords(
  records: readonly TerminalRecord[],
  isLiveWorktree: (worktreeId: string) => boolean,
  shown: readonly string[] = []
): TerminalRecord[] {
  const place = new Map(shown.map((id, index) => [id, index]))
  const rank = (record: TerminalRecord): number => place.get(record.id) ?? shown.length
  return records
    .filter((record) => isLiveWorktree(record.worktreeId))
    .sort((left, right) => left.createdAt - right.createdAt || rank(left) - rank(right))
}
