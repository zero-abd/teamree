// Where a pane goes when nobody said: into the most room, along its longer side. Pure, in the units
// of whatever box it is handed; the window measures pixels, the runtime makes do with a guess.

import type { PaneNode } from './entities'

export type Box = { width: number; height: number }
export type PaneRect = { id: string; x: number; y: number; width: number; height: number }
export type SplitDirection = 'row' | 'column'

/** The smallest pane a split or a drag may leave, in terminal cells. */
export const MIN_PANE_CELLS = { cols: 40, rows: 8 } as const

/** The draggable gap between sibling panes, in CSS pixels. */
export const PANE_GUTTER_PX = 5

const EPSILON = 1e-6

/** Each leaf's box when `root` fills `box`, in reading order; `gutter` comes off between siblings first. */
export function paneRects(root: PaneNode | null, box: Box, gutter = PANE_GUTTER_PX): PaneRect[] {
  const rects: PaneRect[] = []
  const walk = (node: PaneNode, x: number, y: number, width: number, height: number): void => {
    if (node.kind === 'leaf') {
      rects.push({ id: node.terminalId, x, y, width, height })
      return
    }
    const row = node.direction === 'row'
    const room = Math.max(0, (row ? width : height) - gutter * (node.children.length - 1))
    const sizes = shares(node.sizes, node.children.length)
    let offset = 0
    node.children.forEach((child, index) => {
      const span = room * (sizes[index] ?? 0)
      if (row) walk(child, x + offset, y, span, height)
      else walk(child, x, y + offset, width, span)
      offset += span + gutter
    })
  }
  if (root) walk(root, 0, 0, box.width, box.height)
  return rects
}

/** The least room `node` can be given along `direction` with every pane in it at least `min`. */
export function minExtent(node: PaneNode, direction: SplitDirection, min: Box, gutter = PANE_GUTTER_PX): number {
  if (node.kind === 'leaf') return direction === 'row' ? min.width : min.height
  const extents = node.children.map((child) => minExtent(child, direction, min, gutter))
  if (node.direction !== direction) return Math.max(...extents)
  return extents.reduce((sum, extent) => sum + extent, 0) + gutter * (extents.length - 1)
}

/** `added` in the largest pane's place, split along that pane's longer side. */
export function placePane(root: PaneNode | null, added: PaneNode, box: Box, gutter = PANE_GUTTER_PX): PaneNode {
  if (!root) return added
  return placements(root, added, box, gutter).next().value ?? added
}

/** `placePane`, trying smaller panes and the other side until nothing shrinks below `min`; null when nothing fits. */
export function placePaneWithin(
  root: PaneNode | null,
  added: PaneNode,
  box: Box,
  min: Box,
  gutter = PANE_GUTTER_PX
): PaneNode | null {
  if (!root) return added
  for (const placed of placements(root, added, box, gutter)) {
    if (leavesRoom(root, placed, box, min, gutter)) return placed
  }
  return null
}

/** True when every pane `after` that lost width or height kept at least `min` of it. */
export function leavesRoom(
  before: PaneNode | null,
  after: PaneNode,
  box: Box,
  min: Box,
  gutter = PANE_GUTTER_PX
): boolean {
  const was = new Map(paneRects(before, box, gutter).map((rect) => [rect.id, rect]))
  return paneRects(after, box, gutter).every((rect) => {
    const old = was.get(rect.id)
    const narrower = old === undefined || rect.width < old.width - EPSILON
    const shorter = old === undefined || rect.height < old.height - EPSILON
    return (!narrower || rect.width >= min.width - EPSILON) && (!shorter || rect.height >= min.height - EPSILON)
  })
}

function* placements(root: PaneNode, added: PaneNode, box: Box, gutter: number): Generator<PaneNode> {
  // Stable, and quantised so float noise cannot break a tie: equal panes go in reading order.
  const share = (rect: PaneRect): number => Math.round(((rect.width * rect.height) / (box.width * box.height)) * 1e6)
  const largest = paneRects(root, box, gutter).sort((a, b) => share(b) - share(a))
  for (const rect of largest) {
    const longer: SplitDirection = rect.width >= rect.height ? 'row' : 'column'
    yield insertBeside(root, rect.id, longer, added)
    yield insertBeside(root, rect.id, longer === 'row' ? 'column' : 'row', added)
  }
}

/**
 * Joins the nearest split along `direction` above the target, as the sibling after it, and evens that
 * split out: a new column beside columns rather than a half-width sliver. With none, halves the target.
 */
function insertBeside(node: PaneNode, targetId: string, direction: SplitDirection, added: PaneNode): PaneNode {
  if (node.kind === 'leaf') {
    return node.terminalId === targetId
      ? { kind: 'split', direction, sizes: [0.5, 0.5], children: [node, added] }
      : node
  }
  const index = node.children.findIndex((child) => holds(child, targetId))
  const child = node.children[index]
  if (child === undefined) return node
  if (node.direction === direction && !splitsAlong(child, targetId, direction)) {
    const children = [...node.children]
    children.splice(index + 1, 0, added)
    return { kind: 'split', direction, sizes: children.map(() => 1 / children.length), children }
  }
  const children = node.children.map((each, at) =>
    at === index ? insertBeside(each, targetId, direction, added) : each
  )
  return { kind: 'split', direction: node.direction, sizes: [...node.sizes], children }
}

function holds(node: PaneNode, id: string): boolean {
  return node.kind === 'leaf' ? node.terminalId === id : node.children.some((child) => holds(child, id))
}

/** Whether a split along `direction` lies between `node` (inclusive) and the leaf `id`. */
function splitsAlong(node: PaneNode, id: string, direction: SplitDirection): boolean {
  if (node.kind === 'leaf') return false
  if (node.direction === direction) return true
  const next = node.children.find((child) => holds(child, id))
  return next !== undefined && splitsAlong(next, id, direction)
}

function shares(sizes: readonly number[], count: number): number[] {
  const cleaned = Array.from({ length: count }, (_, index) => {
    const value = sizes[index]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  })
  const total = cleaned.reduce((sum, value) => sum + value, 0)
  return total > 0 ? cleaned.map((value) => value / total) : cleaned.map(() => 1 / count)
}
