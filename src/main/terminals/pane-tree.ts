// The split algebra, as pure functions over PaneNode.
//
// Every layout change is expressed here and nowhere else: the session manager
// maps terminals to trees, this file decides what the tree becomes. Nothing in
// this module touches a PTY, which is what makes the interesting cases -- an
// insert next to a same-direction sibling, a collapse that empties a split --
// testable without spawning anything.
//
// Two invariants hold for every tree these functions return:
//   1. a split has at least two children, and none of them is a split in the
//      same direction (a row inside a row is the same picture, flattened);
//   2. its `sizes` has exactly one entry per child, and they sum to 1.

import type { PaneNode } from '../../shared/entities'

export type SplitDirection = 'row' | 'column'

export function leafPane(terminalId: string): PaneNode {
  return { kind: 'leaf', terminalId }
}

export function terminalIdsIn(root: PaneNode | null): string[] {
  if (root === null) return []
  if (root.kind === 'leaf') return [root.terminalId]
  return root.children.flatMap((child) => terminalIdsIn(child))
}

export function containsTerminal(root: PaneNode | null, terminalId: string): boolean {
  if (root === null) return false
  if (root.kind === 'leaf') return root.terminalId === terminalId
  return root.children.some((child) => containsTerminal(child, terminalId))
}

/**
 * Divides the pane holding `targetTerminalId`, giving the new terminal half of
 * it. When that pane already sits in a split of the same direction the new leaf
 * becomes its neighbour rather than a nested split, so repeated splits in one
 * direction stay a single flat row or column.
 *
 * A target that is not in the tree (or an empty tree) degrades to appending at
 * the root, so a stale pane id can never lose the caller their new terminal.
 */
export function splitPane(
  root: PaneNode | null,
  targetTerminalId: string,
  direction: SplitDirection,
  newTerminalId: string
): PaneNode {
  if (root === null) return leafPane(newTerminalId)
  if (!containsTerminal(root, targetTerminalId)) return appendPane(root, newTerminalId, direction)

  if (root.kind === 'leaf') {
    return normalisePane({
      kind: 'split',
      direction,
      sizes: [0.5, 0.5],
      children: [root, leafPane(newTerminalId)]
    })
  }

  return normalisePane(splitWithin(root, targetTerminalId, direction, newTerminalId))
}

/** Adds a pane at the top level, keeping the existing panes' relative sizes. */
export function appendPane(root: PaneNode | null, terminalId: string, direction: SplitDirection = 'row'): PaneNode {
  if (root === null) return leafPane(terminalId)

  if (root.kind === 'split' && root.direction === direction) {
    const share = 1 / (root.children.length + 1)
    const scale = 1 - share
    return normalisePane({
      kind: 'split',
      direction,
      sizes: [...root.sizes.map((size) => size * scale), share],
      children: [...root.children, leafPane(terminalId)]
    })
  }

  return normalisePane({
    kind: 'split',
    direction,
    sizes: [0.5, 0.5],
    children: [root, leafPane(terminalId)]
  })
}

/**
 * Drops the pane for `terminalId`. A split left with one child is replaced by
 * that child, which is what makes closing the last sibling restore the parent
 * rather than leave a one-pane split behind. Returns null when the tree empties.
 */
export function removePane(root: PaneNode | null, terminalId: string): PaneNode | null {
  if (root === null) return null
  if (root.kind === 'leaf') return root.terminalId === terminalId ? null : root

  const kept: PaneNode[] = []
  const keptSizes: number[] = []
  root.children.forEach((child, index) => {
    const next = removePane(child, terminalId)
    if (next === null) return
    kept.push(next)
    keptSizes.push(root.sizes[index] ?? 0)
  })

  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0] ?? null
  return normalisePane({ kind: 'split', direction: root.direction, sizes: keptSizes, children: kept })
}

/** Sizes for `count` children: one non-negative fraction each, summing to 1. */
export function normaliseSizes(sizes: readonly number[], count: number): number[] {
  if (count <= 0) return []

  const cleaned: number[] = []
  for (let index = 0; index < count; index++) {
    const value = sizes[index]
    cleaned.push(typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  }

  const total = cleaned.reduce((sum, value) => sum + value, 0)
  // Nothing usable came in (all zero, all absent, all NaN): split evenly.
  if (total <= 0) return cleaned.map(() => 1 / count)
  return cleaned.map((value) => value / total)
}

/** Canonicalises a subtree: flattens same-direction nesting, collapses
 *  single-child splits, and normalises sizes at every level. */
export function normalisePane(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node

  const children: PaneNode[] = []
  const sizes: number[] = []
  const parentSizes = normaliseSizes(node.sizes, node.children.length)

  node.children.forEach((child, index) => {
    const normalised = normalisePane(child)
    const slot = parentSizes[index] ?? 0
    if (normalised.kind === 'split' && normalised.direction === node.direction) {
      // A row inside a row draws identically to one wider row; hoist it so the
      // tree has a single shape for a single picture.
      normalised.children.forEach((grandchild, inner) => {
        children.push(grandchild)
        sizes.push(slot * (normalised.sizes[inner] ?? 0))
      })
      return
    }
    children.push(normalised)
    sizes.push(slot)
  })

  // Callers never build a childless split; one means the tree was constructed by
  // hand and is not a layout at all, so fail loudly rather than invent a pane.
  if (children.length === 0) throw new Error('pane split has no children')
  const only = children[0]
  if (children.length === 1 && only !== undefined) return only
  return { kind: 'split', direction: node.direction, sizes: normaliseSizes(sizes, children.length), children }
}

/**
 * Validates an untrusted tree (layout.set takes `unknown`) and returns a
 * canonical copy, or null if the shape is wrong. Terminal ids are checked for
 * shape only; whether they exist is the caller's business.
 */
export function parsePaneNode(value: unknown): PaneNode | null {
  const parsed = parseNode(value, 0)
  return parsed === null ? null : normalisePane(parsed)
}

/** Trees deeper than this are certainly corrupt, and recursion has to stop. */
const MAX_PANE_DEPTH = 64

function parseNode(value: unknown, depth: number): PaneNode | null {
  if (depth > MAX_PANE_DEPTH) return null
  if (typeof value !== 'object' || value === null) return null
  const node = value as Record<string, unknown>

  if (node.kind === 'leaf') {
    return typeof node.terminalId === 'string' && node.terminalId.length > 0 ? leafPane(node.terminalId) : null
  }

  if (node.kind !== 'split') return null
  if (node.direction !== 'row' && node.direction !== 'column') return null
  if (!Array.isArray(node.children) || node.children.length === 0) return null

  const children: PaneNode[] = []
  for (const child of node.children) {
    const parsed = parseNode(child, depth + 1)
    if (parsed === null) return null
    children.push(parsed)
  }

  const sizes = Array.isArray(node.sizes) ? node.sizes.filter((size): size is number => typeof size === 'number') : []
  return { kind: 'split', direction: node.direction, sizes: normaliseSizes(sizes, children.length), children }
}

/** Inserts the new leaf beside its target, within an existing split. */
function splitWithin(
  node: PaneNode & { kind: 'split' },
  targetTerminalId: string,
  direction: SplitDirection,
  newTerminalId: string
): PaneNode {
  const children: PaneNode[] = []
  const sizes: number[] = []
  const currentSizes = normaliseSizes(node.sizes, node.children.length)

  node.children.forEach((child, index) => {
    const slot = currentSizes[index] ?? 0

    if (child.kind === 'leaf' && child.terminalId === targetTerminalId) {
      if (node.direction === direction) {
        children.push(child, leafPane(newTerminalId))
        sizes.push(slot / 2, slot / 2)
      } else {
        children.push({
          kind: 'split',
          direction,
          sizes: [0.5, 0.5],
          children: [child, leafPane(newTerminalId)]
        })
        sizes.push(slot)
      }
      return
    }

    if (child.kind === 'split' && containsTerminal(child, targetTerminalId)) {
      children.push(splitWithin(child, targetTerminalId, direction, newTerminalId))
      sizes.push(slot)
      return
    }

    children.push(child)
    sizes.push(slot)
  })

  return { kind: 'split', direction: node.direction, sizes, children }
}
