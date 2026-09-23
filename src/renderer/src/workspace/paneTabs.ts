// What the strip along the top says: one entry per pane of the worktree on screen. A tab owns no
// visibility (every leaf is shown), so it is a name and a jump target; names and states are the sidebar's.

import type { PaneNode, Terminal } from '@shared/entities'
import { collectTerminalIds } from '../panes/paneLayout'
import { ACTIVITY_LABEL, activityOf, paneNames, type AgentActivity, type PaneNameSource } from '../sidebar/agentRows'

export type PaneTab = {
  terminalId: string
  label: string
  /** Null until the terminal's record has arrived; the leaf is on the board either way. */
  activity: AgentActivity | null
}

/** The tabs for one worktree in split-tree order; a leaf without its record yet still gets a tab. */
export function paneTabs(root: PaneNode | null, terminals: Readonly<Record<string, Terminal>>): PaneTab[] {
  const ids = collectTerminalIds(root)
  const panes = ids.map((terminalId) => terminals[terminalId])
  // Named together: what tells two tabs apart is the other tab.
  const names = paneNames(panes.map((pane) => pane ?? UNARRIVED))
  return ids.map((terminalId, index) => {
    const pane = panes[index]
    const label = names[index] ?? 'terminal'
    return { terminalId, label, activity: pane ? activityOf(pane) : null }
  })
}

/** A leaf whose record has not arrived, as a name is read from it. */
const UNARRIVED: PaneNameSource = { title: 'terminal', shell: '' }

/** A tab's tooltip: its name, plus the sidebar's `ACTIVITY_LABEL` phrase when the state is known. */
export function paneTabTitle(tab: PaneTab): string {
  return tab.activity === null ? tab.label : `${tab.label} · ${ACTIVITY_LABEL[tab.activity]}`
}
