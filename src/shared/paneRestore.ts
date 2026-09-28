// How a restored pane says it came back, shared by the scrollback banner and the bar's badge so they agree.

/**
 * How a terminal came back: `agent` resumed, `restarted` agent started fresh, `shell` a plain shell in its place,
 * `stopped` an agent left ended rather than started over (nothing to resume, or its task was done).
 */
export type RestoredAs = 'shell' | 'agent' | 'restarted' | 'stopped'

/** Why a `stopped` agent pane was not started: its task was done, nothing to resume, or it had failed before the quit. */
export type StoppedFor = 'task-done' | 'no-conversation' | 'failed'

/** "fresh claude": an agent started over, as the banner and the badge both say it. */
export function freshAgentLabel(agent: string): string {
  return `fresh ${agent}`
}
