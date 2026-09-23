// What everybody else is doing to one of this machine's panes, looked up by pane id across the
// per-project `teamwork.watchers` answers. LIVENESS IS COMPUTED, NEVER STORED: whether a typist
// counts as "typing" is a question about the clock, asked again on every tick.

import { TYPING_WINDOW_MS, type PaneTypist, type PaneWatcher, type PaneWatchers } from '@shared/entities'

export type PaneAttention = {
  watchers: readonly PaneWatcher[]
  typists: readonly PaneTypist[]
  /** The owner has stopped remote keystrokes reaching this pane. */
  muted: boolean
}

export const NO_ATTENTION: PaneAttention = { watchers: [], typists: [], muted: false }

/** One pane's row out of every project's answer, or nothing when it has none. */
export function paneAttention(byProject: Readonly<Record<string, PaneWatchers>>, terminalId: string): PaneAttention {
  for (const answer of Object.values(byProject)) {
    const pane = answer.panes.find((row) => row.terminalId === terminalId)
    if (pane) return { watchers: pane.watchers, typists: pane.typists, muted: pane.muted }
  }
  return NO_ATTENTION
}

/** What everybody else is doing to each pane of one project, keyed by terminal id. */
export function attentionByPane(watchers: PaneWatchers | undefined): Record<string, PaneAttention> {
  const byPane: Record<string, PaneAttention> = {}
  for (const pane of watchers?.panes ?? []) {
    byPane[pane.terminalId] = { watchers: pane.watchers, typists: pane.typists, muted: pane.muted }
  }
  return byPane
}

/** Whoever's last keystroke is recent enough to call them still at the keyboard. */
export function typingNow(typists: readonly PaneTypist[], now: number): PaneTypist[] {
  return typists.filter((typist) => now - typist.at <= TYPING_WINDOW_MS)
}

/**
 * Whether anybody has ever typed here, which outlives `typingNow`: a pane somebody typed into an
 * hour ago is not the owner's alone.
 */
export function hasBeenTyped(attention: PaneAttention): boolean {
  return attention.typists.some((typist) => typist.writes > 0 || typist.refused > 0)
}
