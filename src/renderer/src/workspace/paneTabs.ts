// What the strip along the top says: one entry per pane of the worktree on screen. A tab owns no
// visibility (every leaf is shown), so it is a name and a jump target; names and states are the sidebar's.

import type { AgentKind, PaneNode, Terminal } from '@shared/entities'
import { isFileLeaf, filePaneName } from '@shared/filePane'
import { collectLeaves } from '../panes/paneLayout'
import {
  activityOf,
  dotTone,
  paneAgent,
  paneNames,
  paneText,
  TONE_LABEL,
  type AgentActivity,
  type PaneNameSource
} from '../sidebar/agentRows'

export type PaneTab = {
  terminalId: string
  agent: AgentKind | undefined
  label: string
  /** What the tab draws beside the glyph; see `paneText`. */
  text: string
  /** Null until the terminal's record has arrived; the leaf is on the board either way. */
  activity: AgentActivity | null
  /** A file pane is named after its file and has no activity to read. */
  kind?: 'file'
}

/** The tabs for one worktree in split-tree order; a leaf without its record yet still gets a tab. */
export function paneTabs(root: PaneNode | null, terminals: Readonly<Record<string, Terminal>>): PaneTab[] {
  const leaves = collectLeaves(root)
  const shells = leaves.filter((node) => !isFileLeaf(node))
  const panes = shells.map((node) => terminals[node.terminalId])
  // Named together: what tells two tabs apart is the other tab. A file pane is named after its file.
  const names = paneNames(panes.map((pane) => pane ?? UNARRIVED))
  return leaves.map((node) => {
    if (isFileLeaf(node)) {
      const label = filePaneName(node.path)
      return { terminalId: node.terminalId, agent: undefined, label, text: label, activity: null, kind: 'file' }
    }
    const index = shells.indexOf(node)
    const record = panes[index]
    const pane = record ?? UNARRIVED
    const label = names[index] ?? 'terminal'
    const activity = record ? activityOf(record) : null
    return { terminalId: node.terminalId, agent: paneAgent(pane), label, text: paneText(pane, label), activity }
  })
}

/** The tab ⌘`n` shows among `ids` in strip order: the Nth for 1–8, the last for 9. */
export function numberedTab(ids: readonly string[], n: number): string | null {
  return (n === 9 ? ids.at(-1) : ids[n - 1]) ?? null
}

/** The tab `step` along from `current`, wrapping; from no tab, forwards is the first and backwards the last. */
export function tabAfter(ids: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const index = current === null ? -1 : ids.indexOf(current)
  const from = index === -1 ? (step === 1 ? -1 : 0) : index
  return ids[(from + step + ids.length) % ids.length] ?? null
}

/** A leaf whose record has not arrived, as a name is read from it. */
const UNARRIVED: PaneNameSource = { title: 'terminal', shell: '' }

/** A tab's tooltip: its name, plus its dot's `TONE_LABEL` word when the state is known. */
export function paneTabTitle(tab: PaneTab): string {
  return tab.activity === null ? tab.label : `${tab.label} · ${TONE_LABEL[dotTone(tab.activity, tab.agent)]}`
}
