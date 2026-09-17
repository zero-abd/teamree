// What the strip along the top of the workspace says: one entry per pane in the
// worktree you are looking at, and nothing from any other worktree.
//
// The strip used to list open worktrees, which made it a second and worse copy
// of the sidebar's middle level — the same names, mixed together across
// projects, with less to say about each of them. The side of the window is
// where sessions belong; the top is the terminals of the session you are in.
//
// A tab here does not own visibility, because there is no visibility to own:
// every leaf of a split tree is on screen at once, and `PaneNode` has nowhere
// to record a pane being hidden. So an entry is a name and a jump target, and
// the tab drawn as the current one is the pane the focused border is already
// drawn around — one fact read in two places rather than two facts kept level.
//
// The names and the states are the sidebar's, imported rather than worked out
// again. A pane called `claude` down the side and `node` along the top would be
// two answers about one pane, and nothing on screen would tell a reader which
// of them the app actually believes.

import type { PaneNode, Terminal } from '@shared/entities'
import { collectTerminalIds } from '../panes/paneLayout'
import { ACTIVITY_LABEL, activityOf, paneLabel, type AgentActivity } from '../sidebar/agentRows'

export type PaneTab = {
  terminalId: string
  label: string
  /** Null until the terminal's record has arrived; the leaf is on the board either way. */
  activity: AgentActivity | null
}

/**
 * The tabs for one worktree, walked out of the split tree rather than off the
 * terminal records.
 *
 * `collectTerminalIds` is the order the panes read on screen and the order
 * `focus-next-pane` steps through them; the records are keyed by id and carry
 * no order anyone would want a strip sorted by.
 *
 * A leaf whose record has not arrived yet still gets a tab, under the same
 * 'terminal' the pane bar paints while it waits. The strip is a directory of
 * the board, and a directory that lists one entry fewer than the thing it
 * describes teaches the reader to stop trusting it.
 */
export function paneTabs(root: PaneNode | null, terminals: Readonly<Record<string, Terminal>>): PaneTab[] {
  return collectTerminalIds(root).map((terminalId) => {
    const terminal = terminals[terminalId]
    if (!terminal) return { terminalId, label: 'terminal', activity: null }
    return { terminalId, label: terminal.agent ?? paneLabel(terminal), activity: activityOf(terminal) }
  })
}

/**
 * The tooltip on a tab: what the pane is called, and what it is doing whenever
 * that is known.
 *
 * The phrase comes from `ACTIVITY_LABEL` so the hover and the sidebar say the
 * same sentence about the same dot. A tab with nothing known about it says only
 * its name, because the alternative is inventing a fifth state for a pane whose
 * record is merely a moment late.
 */
export function paneTabTitle(tab: PaneTab): string {
  return tab.activity === null ? tab.label : `${tab.label} · ${ACTIVITY_LABEL[tab.activity]}`
}
