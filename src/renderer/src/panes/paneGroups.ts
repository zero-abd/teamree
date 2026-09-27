// Tab groups over the split tree. Every leaf is a group: a lone pane, or a `tabs` split whose leaves are drawn
// one at a time under their own strip. A tab moves within its group, into another, or out to an edge; a group
// left with one terminal is that pane again, and one left empty goes, its room handed to its siblings.

import type { PaneNode } from '@shared/entities'
import { isFileColumn, shownTabId, withTabs, type FileColumn } from '@shared/filePane'
import { asGroup, beside, closePane, collectLeaves, hasTerminal, movePane, neighbourTerminalId } from './paneLayout'
import type { DropEdge } from './paneLayout'

type Leaf = Extract<PaneNode, { kind: 'leaf' }>

/** A leaf of the split tree as drawn: one pane, or a group of tabs. */
export type PaneGroup = Leaf | FileColumn

const EMPTY_GROUP: FileColumn = { kind: 'split', direction: 'column', sizes: [], children: [], tabs: true }

/** Every group in reading order. */
export function paneGroups(root: PaneNode | null): PaneGroup[] {
  if (root === null) return []
  if (root.kind === 'leaf' || isFileColumn(root)) return [root]
  return root.children.flatMap(paneGroups)
}

/** The group holding pane `id`, or null. */
export function groupOf(root: PaneNode | null, id: string): PaneGroup | null {
  return paneGroups(root).find((group) => hasTerminal(group, id)) ?? null
}

/** A group's tabs in strip order. */
export function groupTabs(group: PaneGroup | null): Leaf[] {
  if (group === null) return []
  return group.kind === 'leaf' ? [group] : collectLeaves(group)
}

export function groupTabIds(group: PaneGroup | null): string[] {
  return groupTabs(group).map((tab) => tab.terminalId)
}

/** The tab a group draws. */
export function shownOf(group: PaneGroup): string {
  return group.kind === 'leaf' ? group.terminalId : (shownTabId(group) ?? '')
}

/** Every tab, group by group: the order ⌘1–9 and ⌃Tab count in. */
export function stripOrder(root: PaneNode | null): string[] {
  return paneGroups(root).flatMap(groupTabIds)
}

/** `added` as a tab of the group holding `member`, after its shown tab (or at `index`), and shown. */
export function addToGroup(root: PaneNode, member: string, added: Leaf, index?: number): PaneNode {
  const group = groupOf(root, member)
  if (group === null) return root
  const tabs = groupTabs(group)
  const at = index ?? tabs.findIndex((tab) => tab.terminalId === shownOf(group)) + 1
  tabs.splice(clamp(at, 0, tabs.length), 0, added)
  return replaced(root, group, grouped(group, tabs, added.terminalId))
}

/** Tab `id` at `index` of the group holding `target`, shown there; its own group shows its neighbour, or goes. */
export function moveTab(root: PaneNode, id: string, target: string, index: number): PaneNode {
  const from = groupOf(root, id)
  const to = groupOf(root, target)
  const tab = groupTabs(from).find((each) => each.terminalId === id)
  if (from === null || to === null || tab === undefined) return root
  if (from === to) {
    const tabs = groupTabs(from).filter((each) => each !== tab)
    const at = clamp(index, 0, tabs.length)
    if (from.kind === 'leaf' || (groupTabs(from).indexOf(tab) === at && shownOf(from) === id)) return root
    tabs.splice(at, 0, tab)
    return replaced(root, from, grouped(from, tabs, id))
  }
  const rest = closePane(root, id)
  if (rest === null) return root
  return addToGroup(rest, target, tab, clamp(index, 0, groupTabs(to).length))
}

/** Tab `id` let go on `edge` of the group holding `target`: a group of its own there, or last among its tabs. */
export function dropTab(root: PaneNode, id: string, target: string, edge: DropEdge): PaneNode {
  if (edge === 'center') return moveTab(root, id, target, Number.MAX_SAFE_INTEGER)
  const from = groupOf(root, id)
  const to = groupOf(root, target)
  const tab = groupTabs(from).find((each) => each.terminalId === id)
  if (from === null || to === null || tab === undefined) return root
  if (groupTabs(from).length === 1) return movePane(root, id, target, edge)
  // The target group as it will be once the tab has left it, named by a tab that stays.
  const anchor = groupTabIds(to).find((each) => each !== id)
  const rest = closePane(root, id)
  if (rest === null || anchor === undefined) return root
  return beside(rest, anchor, edge, tab)
}

/** Tab `id` into the group `step` along, shown; past either end, out of its group on that side while it has company. */
export function moveTabBy(root: PaneNode, id: string, step: 1 | -1): PaneNode {
  const groups = paneGroups(root)
  const at = groups.findIndex((group) => hasTerminal(group, id))
  const next = groups[at + step]
  if (at === -1) return root
  if (next !== undefined) return moveTab(root, id, shownOf(next), Number.MAX_SAFE_INTEGER)
  return dropTab(root, id, id, step === 1 ? 'right' : 'left')
}

/** Tab `id` out of its group into one of its own, right of it or under it; the same tree for a lone pane. */
export function splitTabOut(root: PaneNode, id: string, direction: 'row' | 'column'): PaneNode {
  return dropTab(root, id, id, direction === 'row' ? 'right' : 'bottom')
}

/** Where focus goes when `id` closes: the tab its group shows next, else the neighbouring pane. */
export function focusAfterClose(root: PaneNode | null, id: string): string | null {
  const others = groupTabIds(groupOf(root, id)).filter((each) => each !== id)
  const rest = others.length > 0 ? closePane(root, id) : null
  const group = others[0] === undefined ? null : groupOf(rest, others[0])
  return group === null ? neighbourTerminalId(root, id) : shownOf(group)
}

/** `group` holding `tabs` with `shown` on show; one terminal alone is that pane. */
function grouped(group: PaneGroup, tabs: PaneNode[], shown: string): PaneNode {
  return asGroup(withTabs(group.kind === 'leaf' ? EMPTY_GROUP : group, tabs, shown))
}

/** `root` with the node `from` swapped for `to`, found by identity. */
function replaced(root: PaneNode, from: PaneNode, to: PaneNode): PaneNode {
  if (root === from) return to
  if (root.kind === 'leaf' || isFileColumn(root)) return root
  return { ...root, children: root.children.map((child) => replaced(child, from, to)) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
