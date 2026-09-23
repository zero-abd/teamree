// How a restored pane says it came back, shared by the scrollback banner and the bar's badge so they agree.

/** How a terminal came back: `agent` resumed, `restarted` agent started fresh, `shell` a plain shell in its place. */
export type RestoredAs = 'shell' | 'agent' | 'restarted'

/** "fresh claude": an agent started over, as the banner and the badge both say it. */
export function freshAgentLabel(agent: string): string {
  return `fresh ${agent}`
}
