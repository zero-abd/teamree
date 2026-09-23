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
import { carriesSelector, restartSessionCommand, resumeSessionCommand } from './agent-command'

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
  /**
   * Whether anybody ever typed into this pane.
   *
   * Written down because it is the one thing this app knows for certain about
   * whether there is a conversation to come back to, and it holds for every
   * agent rather than for one of them. An id can be pinned before an agent
   * starts, but the conversation under it is not written until the agent has
   * something to write — and an agent with nobody talking to it has nothing.
   * So a pane that was opened and then left alone has no conversation on any
   * agent's disk, whatever id was reserved for it, and asking to resume one is
   * asking for something that was never had.
   *
   * Deliberately not "the agent produced output": every agent prints a banner.
   * Input is the part that only happens when somebody meant it.
   *
   * Three values and not two, which is the part worth being careful about.
   * `false` is this version saying nobody has typed. Absent is *unknown* — a
   * record written before this field existed, which is every record in every
   * workspace file already on disk, including all the panes with real
   * conversations behind them. Unknown is not the same as no, and treating it
   * as no would take the resume away from every pane in the world exactly once,
   * on the launch after an upgrade. So unknown tries the resume, which is safe
   * now in a way it was not before: a resume that finds nothing says so, and
   * writes `false` down on its way out, so the pane starts over on the launch
   * after that rather than failing the same way forever.
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
   * Set when the command differs from the one on the record — the pane is
   * starting the agent over under a new id — and carries what the record has to
   * become, so the next launch resumes this run rather than the one before it.
   */
  repinned?: { command: string; agentSessionId?: string }
  /**
   * What to run in this pane if the resume above is refused.
   *
   * A resume can find nothing for reasons that are nobody's fault — the
   * conversation was deleted, it expired, the worktree was last opened on
   * another machine — and the pane has to come back usable either way. So the
   * command that starts the agent over is worked out here, from the same
   * record, and handed down alongside the resume: a pane that is refused says
   * so and starts a fresh agent in the same breath, rather than sitting dead
   * until the launch after next.
   *
   * Absent when there is nothing honest to fall back to: a command that cannot
   * be modelled, or a session the user named themselves. Starting over past a
   * hand-chosen session id means minting one of ours and writing it over
   * theirs, which throws away the only trace anywhere of the conversation they
   * asked for — and they are the one person in a position to know where it is.
   */
  fallback?: { command: string; agentSessionId?: string }
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
 *
 * The one agent pane that is *not* resumed is the one this app has written down
 * that nobody ever typed into. Reserving an id at launch is not the same as
 * there being a conversation under it: the agent writes that down when it has
 * something to write, and a pane that was opened and left alone gave it
 * nothing. Asking to resume such an id gets a refusal from the CLI and a dead
 * pane, every time, for the whole life of the record — so that pane is started
 * over instead, under an id of its own. Re-issuing an agent's own launch is not
 * the thing the refusal above is about: starting an agent is what the pane was
 * for, and it does nothing until it is spoken to.
 *
 * "Written down that nobody typed" and not "no record of anybody typing", which
 * are the same sentence only if you have forgotten that this field is newer
 * than the files it is read out of. See `TerminalRecord.typed`: absent means
 * unknown, and unknown tries.
 */
export function restoreLaunch(record: TerminalRecord): RestoreLaunch {
  if (record.command === undefined || record.agent === undefined) return { resumed: false }

  // Before any of that: a session on the command line that is not ours is not
  // ours to touch. A command naming a session with no pinned id of ours behind
  // it was written that way by whoever opened the pane — `pinSessionCommand`
  // steps back from this same case rather than argue with it — and a session
  // somebody chose by hand is one they have reason to think is there. So the
  // command is re-issued exactly as it was written, which is the only form of
  // it this app can be sure means what they meant: rewriting it around a
  // session id we never held is overruling the one person in a position to
  // know, whether by pinning our own over the top or, as this did until now, by
  // quietly trading a named session for "the last one here".
  if (record.agentSessionId === undefined && carriesSelector(record.command, record.agent)) {
    return { command: record.command, resumed: true }
  }

  if (record.typed === false) {
    const restart = restartSessionCommand(record.command, record.agent)
    // The command could not be modelled well enough to take the old session out
    // of it — a pipeline, a quote that does not close, an agent run through
    // something else. Re-issuing it would leave a dead session id on the line
    // and write a different one into the record, so the two would disagree from
    // here on and nothing would ever notice. A shell in the right directory is
    // the answer this file already gives to everything it cannot model.
    if (restart === null) return { resumed: false }
    // `resumed: false` because nothing was: the pane comes back with a fresh
    // agent in it, and the record of what it printed last time replayed above,
    // exactly as an ordinary pane does.
    return { command: restart.command, resumed: false, repinned: restart }
  }

  const resume = resumeSessionCommand(record.command, record.agent, record.agentSessionId ?? null)
  // The agent offers no way back at all: a shell in the right place is still
  // better than re-running whatever the command was.
  if (resume === null) return { resumed: false }
  const fallback = restartSessionCommand(record.command, record.agent)
  return { command: resume, resumed: true, ...(fallback === null ? {} : { fallback }) }
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
