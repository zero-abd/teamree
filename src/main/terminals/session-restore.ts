// What is worth writing down about a terminal, and what to do with it on the
// way back up. The rule is in `restoreLaunch`: a stored command is re-issued
// only when it resumes something; anything else comes back as a plain shell.

import type { AgentKind } from './agent-command'
import { carriesSelector, restartSessionCommand, resumeSessionCommand } from './agent-command'
import { conversationOnDisk, type ConversationEvidence, type ConversationQuestion } from './agent-conversations'
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
  cols: number
  rows: number
  createdAt: number
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
}

/**
 * How to bring one recorded terminal back. A command is re-issued only when it
 * resumes an agent conversation; `npm run deploy` is not re-run because the app
 * restarted. An agent pane with no conversation in the agent's own store (a
 * keystroke at Claude Code's trust gate is not one) is started over under a new
 * id rather than refused by the CLI on every launch; `typed` decides only where
 * the store cannot answer. `conversation` is a parameter so tests need no disk.
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

  // Evidence first, in both directions: the store is what the resume will read.
  if (evidence === 'absent' || (evidence === 'unknown' && record.typed === false)) {
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
