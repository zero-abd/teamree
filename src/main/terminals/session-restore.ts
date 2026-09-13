// What is worth writing down about a terminal, and what to do with it on the
// way back up.
//
// A PTY is a child process, so quitting the app ends it. What survives is a
// description of what the pane was: which worktree, which directory, which
// shell, and — when the pane was running a coding agent — which session of that
// agent's conversation. Startup turns each of those back into a live terminal.
//
// The rule that matters is in `restoreLaunch`, and it is a refusal: a stored
// command is only ever re-issued when it resumes something. Anything else comes
// back as a plain shell in the same directory.

import type { AgentKind } from './agent-command'
import { resumeSessionCommand } from './agent-command'

/** One terminal, as much of it as outlives the process that ran it. */
export type TerminalRecord = {
  /**
   * The terminal's id, kept across the restart on purpose. Pane layouts are
   * durable and point at terminals by id, so reusing it means the tree that
   * comes back needs no remapping and no pane is ever dropped and re-added.
   */
  id: string
  worktreeId: string
  cwd: string
  shell: string
  /** The command as it was launched, already carrying any id we pinned. */
  command?: string
  /** Which agent that command runs, when it runs one we know how to resume. */
  agent?: AgentKind
  /** The session id we pinned at launch, when the agent let us choose one. */
  agentSessionId?: string
  cols: number
  rows: number
  createdAt: number
}

export type RestoreLaunch = {
  /** The command to run, or undefined for an ordinary interactive shell. */
  command?: string
  /** True when that command picks a conversation back up. */
  resumed: boolean
}

/**
 * How to bring one recorded terminal back.
 *
 * A command is re-issued only when it belongs to an agent that can resume,
 * because then re-running it continues a conversation rather than starting the
 * work again. Every other command is dropped and the pane comes back as a
 * shell.
 *
 * That refusal is the whole point. A pane left running `npm run deploy`, a
 * migration, or a test suite that writes fixtures is not something to re-run
 * because the app was restarted — the user quit, they did not ask for it twice.
 * Coming back to a shell in the right directory is both useful and honest; the
 * alternative is a startup that does something nobody asked for.
 */
export function restoreLaunch(record: TerminalRecord): RestoreLaunch {
  if (record.command === undefined || record.agent === undefined) return { resumed: false }

  const resume = resumeSessionCommand(record.command, record.agent, record.agentSessionId ?? null)
  // The agent offers no way back at all: a shell in the right place is still
  // better than re-running whatever the command was.
  if (resume === null) return { resumed: false }
  return { command: resume, resumed: true }
}

/**
 * Records worth restoring, in a stable order.
 *
 * A worktree that is gone takes its terminals with it — the checkout is not
 * there to start them in, and the layout that referenced them is dropped by the
 * same reconciliation that has always run at startup.
 */
export function restorableRecords(
  records: readonly TerminalRecord[],
  isLiveWorktree: (worktreeId: string) => boolean
): TerminalRecord[] {
  return records
    .filter((record) => isLiveWorktree(record.worktreeId))
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}
