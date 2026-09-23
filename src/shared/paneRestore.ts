// What a pane that came back from the last run says about how it came back,
// in the one place the banner in its scrollback and the badge on its bar both
// read from. The two used to be written separately — the banner said "fresh
// claude below" while the badge two lines above it said "new shell" — and a
// pane that describes itself two ways is a pane the reader stops believing.

/**
 * How a terminal came back from a previous run.
 *
 *   `agent`      a conversation was resumed.
 *   `restarted`  an agent was started over, because the conversation it would
 *                have resumed is not there to resume. Still an agent pane.
 *   `shell`      the pane and its directory came back; whatever was running did
 *                not, and a plain shell is open in its place.
 */
export type RestoredAs = 'shell' | 'agent' | 'restarted'

/** "fresh claude": an agent started over, as the banner and the badge both say it. */
export function freshAgentLabel(agent: string): string {
  return `fresh ${agent}`
}
