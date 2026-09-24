// Pure operations over the PaneNode split tree. Everything here is total and
// side-effect free so the layout can be reasoned about (and tested) without a
// DOM: the components below only translate the results into CSS.

import type { PaneNode } from '@shared/entities'
import {
  fileColumnIn,
  isFileColumn,
  isFileLeaf,
  shownTabId,
  withTabs,
  type FileColumn,
  type FileLeaf
} from '@shared/filePane'
import { leavesRoom, PANE_GUTTER_PX, paneRects, type Box } from '@shared/paneRoom'

/** Smallest slice of a split a pane may shrink to, as a fraction of the axis. */
export const MIN_PANE_FRACTION = 0.08

/** Thickness of the draggable gutter drawn between siblings, in CSS pixels. */
export const GUTTER_PX = PANE_GUTTER_PX

export function leaf(terminalId: string): PaneNode {
  return { kind: 'leaf', terminalId }
}

export function collectTerminalIds(node: PaneNode | null): string[] {
  return collectLeaves(node).map((leaf) => leaf.terminalId)
}

/** Every leaf in reading order, terminal and file alike. */
export function collectLeaves(node: PaneNode | null): Extract<PaneNode, { kind: 'leaf' }>[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(collectLeaves)
}

/** Leaf ids in reading order with the file column as one stop, its shown tab: the strip's and the walks' order. */
export function paneStops(node: PaneNode | null): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.terminalId]
  if (isFileColumn(node)) return [shownTabId(node) ?? []].flat()
  return node.children.flatMap(paneStops)
}

export function hasTerminal(node: PaneNode | null, terminalId: string): boolean {
  return collectTerminalIds(node).includes(terminalId)
}

/**
 * Rewrites `sizes` so it is exactly `count` long, every entry is at least
 * `min`, and the whole thing sums to 1. Missing or corrupt entries (a layout
 * from an older build, a truncated array) fall back to an even share rather
 * than collapsing the pane to nothing.
 */
export function normalizeSizes(sizes: readonly number[], count: number, min = MIN_PANE_FRACTION): number[] {
  if (count <= 0) return []
  const even = 1 / count
  const cap = Math.min(min, even)

  const raw: number[] = []
  for (let i = 0; i < count; i++) {
    const value = sizes[i]
    raw.push(typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : even)
  }

  const total = raw.reduce((sum, value) => sum + value, 0)
  const scaled = raw.map((value) => value / total)

  // Lift anything under the floor, then take the difference back from the
  // panes that can spare it, proportionally to their surplus.
  const lifted = scaled.map((value) => Math.max(value, cap))
  const overflow = lifted.reduce((sum, value) => sum + value, 0) - 1
  if (overflow > 1e-9) {
    const surplus = lifted.reduce((sum, value) => sum + Math.max(0, value - cap), 0)
    if (surplus > 1e-9) {
      for (let i = 0; i < lifted.length; i++) {
        const value = lifted[i] ?? cap
        lifted[i] = value - (Math.max(0, value - cap) / surplus) * overflow
      }
    }
  }

  const finalTotal = lifted.reduce((sum, value) => sum + value, 0)
  return lifted.map((value) => value / finalTotal)
}

/**
 * Moves the boundary between `index` and `index + 1` by `deltaPx`, leaving every other pane untouched.
 * `min` is a floor fraction for all, or each child's least size in pixels (`minExtent`).
 */
export function applyGutterDrag(
  sizes: readonly number[],
  index: number,
  deltaPx: number,
  containerPx: number,
  min: number | readonly number[] = MIN_PANE_FRACTION
): number[] {
  const next = normalizeSizes(sizes, sizes.length, typeof min === 'number' ? min : MIN_PANE_FRACTION)
  const before = next[index]
  const after = next[index + 1]
  if (before === undefined || after === undefined || containerPx <= 0) return next

  const floor = (at: number): number =>
    typeof min === 'number' ? Math.min(min, 1 / sizes.length) : (min[at] ?? 0) / containerPx
  // A side already under its floor may grow, never shrink further.
  const lowest = Math.min(0, floor(index) - before)
  const highest = Math.max(0, after - floor(index + 1))
  const delta = clamp(deltaPx / containerPx, lowest, highest)
  next[index] = before + delta
  next[index + 1] = after - delta
  return next
}

/** Flex basis for each child, with the gutters taken off the top first. */
export function splitChildBases(sizes: readonly number[], gutterPx = GUTTER_PX): string[] {
  const normalized = normalizeSizes(sizes, sizes.length)
  const gutters = Math.max(0, normalized.length - 1) * gutterPx
  return normalized.map((fraction) => `calc((100% - ${gutters}px) * ${round(fraction)})`)
}

/**
 * Splits the pane holding `terminalId` in two. Splitting along the axis the
 * parent already uses extends that parent instead of nesting another level,
 * which keeps deep layouts flat enough to resize sensibly.
 */
export function splitPane(
  root: PaneNode | null,
  terminalId: string,
  direction: 'row' | 'column',
  newTerminalId: string
): PaneNode {
  return splitPaneWith(root, terminalId, direction, leaf(newTerminalId))
}

/** `splitPane` for a leaf built by the caller, which is how a file pane arrives; `before` puts it first. */
export function splitPaneWith(
  root: PaneNode | null,
  terminalId: string,
  direction: 'row' | 'column',
  added: PaneNode,
  before = false
): PaneNode {
  if (!root) return added
  // The file column splits as one pane: a tab's split goes beside the column.
  const isTarget = (node: PaneNode): boolean =>
    node.kind === 'leaf' ? node.terminalId === terminalId : isFileColumn(node) && hasTerminal(node, terminalId)
  if (root.kind === 'leaf' || isFileColumn(root)) {
    if (!isTarget(root)) return root
    return { kind: 'split', direction, sizes: [0.5, 0.5], children: before ? [added, root] : [root, added] }
  }

  const index = root.children.findIndex(isTarget)
  if (index !== -1 && root.direction === direction) {
    const sizes = normalizeSizes(root.sizes, root.children.length)
    const share = sizes[index] ?? 1 / sizes.length
    const children = [...root.children]
    children.splice(before ? index : index + 1, 0, added)
    const nextSizes = [...sizes]
    nextSizes.splice(index, 1, share / 2, share / 2)
    return { kind: 'split', direction: root.direction, sizes: normalizeSizes(nextSizes, children.length), children }
  }

  return {
    kind: 'split',
    direction: root.direction,
    sizes: normalizeSizes(root.sizes, root.children.length),
    children: root.children.map((child) => splitPaneWith(child, terminalId, direction, added, before))
  }
}

/**
 * A new file column beside the largest pane that can spare it, half the centre wide where that leaves room,
 * else under the largest shell; never under an agent. Null when every place starves a pane below `min`.
 */
export function placeFileColumn(
  root: PaneNode | null,
  column: FileColumn,
  box: Box,
  min: Box,
  isAgent: (id: string) => boolean
): PaneNode | null {
  if (!root) return column
  const area = (rect: { width: number; height: number }): number => Math.round(rect.width * rect.height)
  const largest = paneRects(root, box).sort((a, b) => area(b) - area(a))
  const tries: PaneNode[] = []
  for (const rect of largest) {
    const half = Math.min(1, box.width / 2 / rect.width)
    for (const share of half > 0.5 ? [half, 0.5] : [0.5]) tries.push(inPlaceOf(root, rect.id, 'row', column, share))
  }
  for (const rect of largest) if (!isAgent(rect.id)) tries.push(inPlaceOf(root, rect.id, 'column', column, 0.5))
  return tries.find((tree) => leavesRoom(root, tree, box, min)) ?? null
}

/** The leaf `id` and `added` split along `direction`, `added` after it with `share`; flattened as the runtime stores it. */
function inPlaceOf(root: PaneNode, id: string, direction: 'row' | 'column', added: PaneNode, share: number): PaneNode {
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      return node.terminalId === id
        ? { kind: 'split', direction, sizes: [1 - share, share], children: [node, added] }
        : node
    }
    return isFileColumn(node) ? node : { ...node, children: node.children.map(walk) }
  }
  return flatten(walk(root))
}

/** Adds a pane at the top level, the way the runtime's `terminal.create` does. */
export function appendPane(root: PaneNode | null, added: PaneNode, direction: 'row' | 'column' = 'row'): PaneNode {
  if (!root) return added
  if (root.kind === 'split' && root.direction === direction && !isFileColumn(root)) {
    const share = 1 / (root.children.length + 1)
    const sizes = normalizeSizes(root.sizes, root.children.length).map((size) => size * (1 - share))
    return { kind: 'split', direction, sizes: [...sizes, share], children: [...root.children, added] }
  }
  return { kind: 'split', direction, sizes: [0.5, 0.5], children: [root, added] }
}

/**
 * Removes a pane, handing its space back to its siblings in proportion. A
 * split left with one child dissolves into that child.
 */
export function closePane(root: PaneNode | null, terminalId: string): PaneNode | null {
  if (!root) return null
  if (root.kind === 'leaf') return root.terminalId === terminalId ? null : root

  const sizes = normalizeSizes(root.sizes, root.children.length)
  const kept: PaneNode[] = []
  const keptSizes: number[] = []
  root.children.forEach((child, i) => {
    const next = closePane(child, terminalId)
    if (next) {
      kept.push(next)
      keptSizes.push(sizes[i] ?? 0)
    }
  })

  if (kept.length === 0) return null
  if (isFileColumn(root)) return withTabs(root, kept, shownAfterClose(root, kept))
  if (kept.length === 1) return kept[0] ?? null
  return { kind: 'split', direction: root.direction, sizes: normalizeSizes(keptSizes, kept.length), children: kept }
}

/** The shown tab once some closed: itself, else the tab now at its place, else the one before. */
function shownAfterClose(column: FileColumn, kept: readonly PaneNode[]): string | undefined {
  const ids = column.children.map((child) => (child.kind === 'leaf' ? child.terminalId : ''))
  const left = new Set(kept.map((child) => (child.kind === 'leaf' ? child.terminalId : '')))
  const at = column.shown === undefined ? -1 : ids.indexOf(column.shown)
  if (at === -1) return column.shown
  return ids.slice(at).find((id) => left.has(id)) ?? ids.slice(0, at).findLast((id) => left.has(id))
}

/**
 * `added` as a tab of the file column, shown: after the shown tab, or in `replace`'s place.
 * `preview` makes it the tab the next preview open replaces. A tree without a column comes back as is.
 */
export function addTab(
  root: PaneNode,
  added: FileLeaf,
  { preview = false, replace }: { preview?: boolean; replace?: string | undefined } = {}
): PaneNode {
  return mapColumn(root, (column) => {
    const tabs = [...column.children]
    const indexOf = (id: string | undefined): number => tabs.findIndex((tab) => hasTerminal(tab, id ?? ''))
    const replaced = indexOf(replace)
    if (replaced !== -1) tabs.splice(replaced, 1, added)
    else tabs.splice(indexOf(shownTabId(column)) + 1 || tabs.length, 0, added)
    const next = withTabs(column, tabs, added.terminalId)
    return preview ? { ...next, preview: added.terminalId } : next
  })
}

/** The tree with the column holding `id` showing it; the same tree when it already did. */
export function showTab(root: PaneNode, id: string): PaneNode {
  return mapColumn(root, (column) =>
    column.shown === id || !hasTerminal(column, id) ? column : { ...column, shown: id }
  )
}

/** The tree with `id` no longer the preview tab; the same tree when it was not. */
export function pinTab(root: PaneNode, id: string): PaneNode {
  return mapColumn(root, (column) => {
    if (column.preview !== id) return column
    const pinned = { ...column }
    delete pinned.preview
    return pinned
  })
}

/** `root` with each file column replaced by `change`'s answer; untouched subtrees keep their identity. */
function mapColumn(root: PaneNode, change: (column: FileColumn) => FileColumn): PaneNode {
  if (root.kind === 'leaf') return root
  if (isFileColumn(root)) return change(root)
  const children = root.children.map((child) => mapColumn(child, change))
  return children.every((child, index) => child === root.children[index]) ? root : { ...root, children }
}

/** Where a dragged pane lands on another: beside it on one side, or in its place (`center`, a swap). */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * The pane holding `id` moved to `edge` of the pane holding `targetId`, the file column moving as one.
 * The same tree when either is missing or both are the same pane.
 */
export function movePane(root: PaneNode, id: string, targetId: string, edge: DropEdge): PaneNode {
  const stops = stopsOf(root)
  const from = stops.findIndex((stop) => hasTerminal(stop, id))
  const to = stops.findIndex((stop) => hasTerminal(stop, targetId))
  const moved = stops[from]
  if (moved === undefined || to === -1 || from === to) return root
  if (edge === 'center') {
    return withStops(
      root,
      stops.map((stop, at) => (at === from ? (stops[to] ?? stop) : at === to ? moved : stop))
    )
  }
  const rest = collectTerminalIds(moved).reduce<PaneNode | null>((tree, each) => closePane(tree, each), root)
  return rest === null ? root : beside(rest, targetId, edge, moved)
}

/** The column's tab `id` taken out as a pane of its own at `edge` of `targetId`; the same tree when it cannot be. */
export function moveTabOut(root: PaneNode, id: string, targetId: string, edge: DropEdge): PaneNode {
  const tab = fileColumnIn(root)?.children.find((child) => child.kind === 'leaf' && child.terminalId === id)
  if (tab === undefined || edge === 'center') return root
  const rest = closePane(root, id)
  return rest === null || !hasTerminal(rest, targetId) ? root : beside(rest, targetId, edge, tab)
}

/** The pane holding `id` moved to `index` in the strip's order: panes change places, places keep their sizes. */
export function reorderPanes(root: PaneNode, id: string, index: number): PaneNode {
  const stops = stopsOf(root)
  const from = stops.findIndex((stop) => hasTerminal(stop, id))
  const to = clamp(index, 0, stops.length - 1)
  const [moved] = from === -1 ? [] : stops.splice(from, 1)
  if (moved === undefined || from === to) return root
  stops.splice(to, 0, moved)
  return withStops(root, stops)
}

/** The file pane `id` at `index` among the column's tabs, from inside it or from a pane of its own. */
export function placeTab(root: PaneNode, id: string, index: number): PaneNode {
  const column = fileColumnIn(root)
  const tab = collectLeaves(root).find((each) => each.terminalId === id)
  if (column === null || !isFileLeaf(tab)) return root
  const inColumn = column.children.includes(tab)
  const at = clamp(index, 0, column.children.length - (inColumn ? 1 : 0))
  if (inColumn && column.children.indexOf(tab) === at) return root
  const rest = inColumn ? root : closePane(root, id)
  if (rest === null) return root
  return mapColumn(rest, (current) => {
    const tabs = current.children.filter((child) => child !== tab)
    tabs.splice(at, 0, tab)
    return withTabs(current, tabs, inColumn ? current.shown : id)
  })
}

/** Where the pane holding `id` stands in the strip's order, the column as one; -1 when not in the tree. */
export function paneStopIndex(root: PaneNode | null, id: string): number {
  return root === null ? -1 : stopsOf(root).findIndex((stop) => hasTerminal(stop, id))
}

/** The panes as the strip lists them: leaves, and the file column whole. */
function stopsOf(node: PaneNode): PaneNode[] {
  return node.kind === 'leaf' || isFileColumn(node) ? [node] : node.children.flatMap(stopsOf)
}

/** `root` with its stops, in reading order, replaced by `stops`; the shape and every size stay. */
function withStops(root: PaneNode, stops: readonly PaneNode[]): PaneNode {
  let at = 0
  const walk = (node: PaneNode): PaneNode =>
    node.kind === 'leaf' || isFileColumn(node) ? (stops[at++] ?? node) : { ...node, children: node.children.map(walk) }
  return walk(root)
}

function beside(root: PaneNode, targetId: string, edge: Exclude<DropEdge, 'center'>, added: PaneNode): PaneNode {
  const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
  return flatten(splitPaneWith(root, targetId, direction, added, edge === 'left' || edge === 'top'))
}

/** Same-direction splits merged into their parent, as the runtime stores them; the column stays whole. */
function flatten(node: PaneNode): PaneNode {
  if (node.kind === 'leaf' || isFileColumn(node)) return node
  const sizes = normalizeSizes(node.sizes, node.children.length)
  const children: PaneNode[] = []
  const shares: number[] = []
  node.children.forEach((child, index) => {
    const flat = flatten(child)
    const share = sizes[index] ?? 0
    if (flat.kind === 'split' && !isFileColumn(flat) && flat.direction === node.direction) {
      const inner = normalizeSizes(flat.sizes, flat.children.length)
      children.push(...flat.children)
      shares.push(...inner.map((size) => size * share))
    } else {
      children.push(flat)
      shares.push(share)
    }
  })
  return { ...node, sizes: shares, children }
}

/** Replaces the sizes of the split at `path`, addressed by child indices. */
export function setSizesAt(root: PaneNode, path: readonly number[], sizes: readonly number[]): PaneNode {
  if (root.kind === 'leaf') return root
  if (path.length === 0) {
    return { ...root, sizes: normalizeSizes(sizes, root.children.length) }
  }
  const [head, ...rest] = path
  return {
    ...root,
    children: root.children.map((child, i) => (i === head ? setSizesAt(child, rest, sizes) : child))
  }
}

/**
 * The tree as it is drawn: one pane filling the workspace, or all of them.
 *
 * Maximising is done here, over the tree on its way to the screen, rather than
 * by rewriting the layout — which is the difference between a way of looking at
 * an arrangement and an arrangement. Nothing is saved, nothing is rebuilt to
 * restore, and the pane keeps its identity all the way through: `PaneTree` keys
 * its leaves by terminal id, so the maximised pane is the same React element it
 * was in the tree and neither maximising nor restoring remounts an emulator.
 *
 * An id that is not in this tree gives the whole tree back. That is the case
 * where the maximised pane has since been closed or belongs to the worktree
 * that was open a moment ago, and a blank workspace is the wrong answer to it.
 */
export function shownRoot(root: PaneNode | null, expandedTerminalId: string | null): PaneNode | null {
  if (expandedTerminalId === null) return root
  // A file tab fills the centre with its column, the other tabs still on it.
  const column = fileColumnIn(root)
  if (column && hasTerminal(column, expandedTerminalId)) return column
  return collectLeaves(root).find((node) => node.terminalId === expandedTerminalId) ?? root
}

/** `root` without its file column, the column's share handed back to its siblings. */
export function withoutColumn(root: PaneNode | null): PaneNode | null {
  const column = fileColumnIn(root)
  return column === null ? root : collectTerminalIds(column).reduce(closePane, root)
}

/** True when `root` as sized leaves a pane under `min` in `box` and the tree without its file column does not. */
export function foldsColumn(root: PaneNode | null, box: Box, min: Box): boolean {
  const rest = withoutColumn(root)
  return rest !== root && rest !== null && !fitsAsSized(root, box, min) && fitsAsSized(rest, box, min)
}

function fitsAsSized(root: PaneNode | null, box: Box, min: Box): boolean {
  return paneRects(root, box).every((rect) => rect.width >= min.width - 1e-6 && rect.height >= min.height - 1e-6)
}

/** `root` with its file column cut to `min` along its parent split, its siblings taking the rest; else `root`. */
export function narrowColumn(root: PaneNode | null, box: Box, min: Box): PaneNode | null {
  const column = fileColumnIn(root)
  const path = root && column && pathTo(root, column)
  const parentPath = path?.slice(0, -1) ?? []
  const parent = root && path && path.length > 0 ? nodeAt(root, parentPath) : null
  const rect = paneRects(root, box).find((each) => hasTerminal(column, each.id))
  if (!root || !path || parent?.kind !== 'split' || !rect) return root
  const row = parent.direction === 'row'
  const extent = row ? rect.width : rect.height
  const floor = row ? min.width : min.height
  const index = path.at(-1) ?? 0
  const sizes = normalizeSizes(parent.sizes, parent.children.length)
  const share = sizes[index] ?? 0
  if (extent <= floor || share >= 1) return root
  const narrowed = (share * floor) / extent
  const scale = (1 - narrowed) / (1 - share)
  return setSizesAt(
    root,
    parentPath,
    sizes.map((size, at) => (at === index ? narrowed : size * scale))
  )
}

export type SplitPlan = { before: PaneNode | null; after: PaneNode; folded: boolean }

/**
 * Where a split of `targetId` goes: as asked, else with the file column narrowed to its floor, else with
 * the column folded to its tab. Null when the terminals alone cannot give every pane `min`.
 */
export function planSplit(
  root: PaneNode | null,
  targetId: string,
  direction: 'row' | 'column',
  addedId: string,
  box: Box,
  min: Box
): SplitPlan | null {
  const plain = splitPane(root, targetId, direction, addedId)
  if (leavesRoom(root, plain, box, min)) return { before: root, after: plain, folded: false }
  const narrowed = narrowColumn(root, box, min)
  const beside = splitPane(narrowed, targetId, direction, addedId)
  if (narrowed !== root && leavesRoom(root, beside, box, min)) return { before: narrowed, after: beside, folded: false }
  return foldsColumn(plain, box, min) ? { before: root, after: plain, folded: true } : null
}

function pathTo(node: PaneNode, target: PaneNode): number[] | null {
  if (node === target) return []
  if (node.kind === 'leaf') return null
  for (const [index, child] of node.children.entries()) {
    const rest = pathTo(child, target)
    if (rest) return [index, ...rest]
  }
  return null
}

function nodeAt(root: PaneNode, path: readonly number[]): PaneNode | null {
  return path.reduce<PaneNode | null>(
    (node, index) => (node?.kind === 'split' ? (node.children[index] ?? null) : null),
    root
  )
}

/**
 * The pane focus should land on once `terminalId` goes away: its next sibling
 * in document order, or the previous one if it was last.
 */
export function neighbourTerminalId(root: PaneNode | null, terminalId: string): string | null {
  const ids = collectTerminalIds(root)
  const index = ids.indexOf(terminalId)
  if (index === -1) return null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
