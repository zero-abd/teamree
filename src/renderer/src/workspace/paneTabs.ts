// What the strip along the top says: one entry per pane of the worktree on screen, the file column as one.
// A tab owns no visibility, so it is a name and a jump target; names and states are the sidebar's.

import type { AgentKind, PaneNode, Terminal } from '@shared/entities'
import { fileLeavesIn, fileTabName, isFileColumn, isFileLeaf, shownTabId, type FileColumn } from '@shared/filePane'
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
import type { WorktreeNameSource } from '../sidebar/worktreeDisplay'

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
  /** The file column's tabs, when this tab is the column; `terminalId` is the shown one. */
  files?: string[]
  /** A column of one file that the next preview open replaces. */
  preview?: true
  /** Each file's name, for a column of several. */
  names?: string[]
}

/** The tabs for one worktree in split-tree order; a leaf without its record yet still gets a tab. */
export function paneTabs(
  root: PaneNode | null,
  terminals: Readonly<Record<string, Terminal>>,
  worktree?: WorktreeNameSource
): PaneTab[] {
  const leaves = stripLeaves(root)
  const shells = leaves.flatMap((node) => (node.kind === 'leaf' && !isFileLeaf(node) ? [node] : []))
  const panes = shells.map((node) => terminals[node.terminalId])
  // Named together: what tells two tabs apart is the other tab. A file pane is named after its file.
  const names = paneNames(
    panes.map((pane) => pane ?? UNARRIVED),
    worktree
  )
  return leaves.map((node) => {
    if (isFileColumn(node)) {
      const files = fileLeavesIn(node)
      const shown = files.find((file) => file.terminalId === shownTabId(node)) ?? files[0]
      const ids = files.map((file) => file.terminalId)
      const tab = { terminalId: shown?.terminalId ?? '', agent: undefined, activity: null, kind: 'file' as const }
      // One file is named on this tab alone; several keep their names on the column's own tabs.
      if (files.length > 1)
        return { ...tab, label: `Files ${files.length}`, text: 'Files', files: ids, names: files.map(fileTabName) }
      const label = shown === undefined ? '' : fileTabName(shown)
      const preview = shown !== undefined && node.preview === shown.terminalId
      return { ...tab, label, text: label, files: ids, ...(preview ? { preview: true as const } : {}) }
    }
    if (isFileLeaf(node)) {
      const label = fileTabName(node)
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

/** The strip's panes in tree order: leaves, and the file column whole. */
function stripLeaves(node: PaneNode | null): Array<Extract<PaneNode, { kind: 'leaf' }> | FileColumn> {
  if (node === null) return []
  if (node.kind === 'leaf' || isFileColumn(node)) return [node]
  return node.children.flatMap(stripLeaves)
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
  if (tab.names !== undefined) return tab.names.join(', ')
  return tab.activity === null ? tab.label : `${tab.label} · ${TONE_LABEL[dotTone(tab.activity, tab.agent)]}`
}
