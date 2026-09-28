// What a group's strip says: one tab per pane, terminal or file, in the tree's order.
// A tab owns no visibility, so it is a name and a jump target; names and states are the sidebar's.

import type { AgentKind, PaneNode, Terminal } from '@shared/entities'
import { fileTabName, isFileColumn, isFileLeaf } from '@shared/filePane'
import { collectLeaves } from '../panes/paneLayout'
import {
  dotTone,
  paneActivity,
  paneAgent,
  paneNamesById,
  TONE_LABEL,
  type AgentActivity,
  type PaneNameSource
} from '../sidebar/agentRows'
import { worktreeDisplay, type WorktreeNameSource } from '../sidebar/worktreeDisplay'
import { harnessName } from '../agents/harnesses'

export type PaneTab = {
  terminalId: string
  agent: AgentKind | undefined
  label: string
  /** What the tab draws beside the glyph. */
  text: string
  /** Null until the terminal's record has arrived; the leaf is on the board either way. */
  activity: AgentActivity | null
  /** A file pane is named after its file and has no activity to read. */
  kind?: 'file'
  /** A file tab that the next preview open replaces. */
  preview?: true
}

/** The tabs of `root`, a tree or one group, in tree order; a leaf without its record yet still gets a tab. */
export function paneTabs(
  root: PaneNode | null,
  terminals: Readonly<Record<string, Terminal>>,
  worktree?: WorktreeNameSource
): PaneTab[] {
  const leaves = collectLeaves(root)
  const worktreeId = leaves.map((node) => terminals[node.terminalId]?.worktreeId).find((id) => id !== undefined)
  // Named with the worktree's other panes, in the order they were opened, as the sidebar names them.
  const names = paneNamesById(
    Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId),
    worktree
  )
  const previews = new Set(previewsIn(root))
  const title = worktree === undefined ? undefined : worktreeDisplay(worktree).title
  return leaves.map((node) => {
    if (isFileLeaf(node)) {
      const label = fileTabName(node)
      const tab = {
        terminalId: node.terminalId,
        agent: undefined,
        label,
        text: label,
        activity: null,
        kind: 'file' as const
      }
      return previews.has(node.terminalId) ? { ...tab, preview: true as const } : tab
    }
    const record = terminals[node.terminalId]
    const pane = record ?? UNARRIVED
    const label = names[node.terminalId] ?? 'terminal'
    const activity = record ? paneActivity(record, worktree?.report) : null
    const agent = paneAgent(pane)
    // The task's own pane is named after its worktree, which the header over the strip says: its tab says the agent.
    const text = agent !== undefined && label === title ? harnessName(agent) : label
    return { terminalId: node.terminalId, agent, label, text, activity }
  })
}

function previewsIn(node: PaneNode | null): string[] {
  if (node === null || node.kind === 'leaf') return []
  if (isFileColumn(node)) return node.preview === undefined ? [] : [node.preview]
  return node.children.flatMap(previewsIn)
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
