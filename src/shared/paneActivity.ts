// What a pane is doing, read from a PTY rather than an agent's protocol: bytes arriving, how the
// process ended, the title, the bell, and, outranking all of them, what the agent's hooks report.

import type { AgentEvent, AgentKind } from './entities'
import type { ScreenOpinion } from './screenOpinion'
import type { TitleOpinion } from './titleOpinion'

export type AgentActivity =
  /** The pane has said it wants something: it rang the bell, or its title says so. */
  | 'waiting'
  /** Output is still arriving. */
  | 'working'
  /** Running, but it has stopped saying things, and has said nothing about why. */
  | 'quiet'
  /** Exited cleanly. */
  | 'done'
  /** Exited with a non-zero status, or on a signal. */
  | 'failed'

/**
 * The facts an activity is read from. Narrower than `Terminal` so a teammate's
 * pane, which crosses the wire as metadata, is read by the same function.
 */
export type PaneActivitySource = {
  agent?: AgentKind
  foregroundAgent?: AgentKind
  running: boolean
  exitCode?: number
  busy: boolean
  /** What the pane's own title says, when it says anything. */
  titleSays?: TitleOpinion
  /** What the bottom of its screen says. */
  screenSays?: ScreenOpinion
  /** When the bell last rang, if it rang in the burst of output that just ended. */
  lastBellAt?: number
  /** What the agent last reported about itself, when it reports at all. */
  agentEvent?: AgentEvent
  tookTurn?: boolean
}

/**
 * Notification types about the agent rather than aimed at you. An unknown type
 * is read as a request: a request missed is worse than a needless glance.
 */
const NOT_A_REQUEST = new Set([
  'auth_success',
  // Claude's reminder that a finished turn is still finished; a hookless agent says nothing, and must read the same.
  'idle_prompt',
  'agent_completed',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled'
])

/**
 * What the agent's last word says the pane is doing, or null. `UserPromptSubmit`
 * stands however long the pane is silent: a model call prints nothing.
 */
export function agentSays(event: AgentEvent | undefined): AgentActivity | null {
  if (event === undefined) return null
  switch (event.event) {
    case 'Notification':
      return event.detail !== undefined && NOT_A_REQUEST.has(event.detail) ? null : 'waiting'
    case 'UserPromptSubmit':
      return 'working'
    case 'Stop':
    case 'SessionStart':
    case 'SessionEnd':
      return 'quiet'
  }
}

/**
 * The order is the argument: exit, then the agent's own word, then a title or
 * screen saying waiting (an agent can print its question and sit on it), then the bell,
 * then the readings of silence. A stale "working" title ranks below the bell on purpose.
 */
export function activityOf(terminal: PaneActivitySource): AgentActivity {
  if (!terminal.running) {
    if (terminal.exitCode !== 0) return 'failed'
    // Declining a trust prompt also exits 0; only an agent that took a turn finished one.
    return terminal.tookTurn === false ? 'quiet' : 'done'
  }
  const said = agentSays(terminal.agentEvent)
  if (said !== null) return said
  // A shell rings for a failed tab completion: only an agent can be asking.
  const agent = terminal.agent ?? terminal.foregroundAgent
  if (agent !== undefined && (terminal.titleSays === 'waiting' || terminal.screenSays === 'waiting')) return 'waiting'
  if (terminal.busy) return 'working'
  if (agent !== undefined && terminal.lastBellAt !== undefined) return 'waiting'
  return terminal.titleSays === 'working' ? 'working' : 'quiet'
}
