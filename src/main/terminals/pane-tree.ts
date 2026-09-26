// The split algebra, as pure functions over PaneNode. Invariants: a split has
// at least two children, none a split in the same direction; `sizes` has one
// entry per child and they sum to 1. The file column is exempt from the first two.

import type { PaneNode } from '../../shared/entities'
import {
  commitLeaf,
  compareLeaf,
  fileLeaf,
  reviewLeaf,
  sharedNoteLeaf,
  isFileColumn,
  isFileLeaf,
  withTabs
} from '../../shared/filePane'

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
 * it. A target not in the tree degrades to appending at the root.
 */
export function splitPane(
  root: PaneNode | null,
  targetTerminalId: string,
  direction: SplitDirection,
  newTerminalId: string
): PaneNode {
  if (root === null) return leafPane(newTerminalId)
  if (!containsTerminal(root, targetTerminalId)) return appendPane(root, newTerminalId, direction)

  if (root.kind === 'leaf' || isFileColumn(root)) {
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

  if (root.kind === 'split' && root.direction === direction && !isFileColumn(root)) {
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

/** Drops the pane for `terminalId`; a split left with one child becomes that child. Null when empty. */
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
  // The file column keeps a last tab rather than dissolving into it.
  if (isFileColumn(root)) return withTabs(root, kept)
  if (kept.length === 1) return kept[0] ?? null
  return normalisePane({ kind: 'split', direction: root.direction, sizes: keptSizes, children: kept })
}

/** Where a pane sat: the panes of the sibling beside it, the split's direction, and which side. */
export type PanePlace = { beside: string[]; direction: SplitDirection; before: boolean }

/** The place of pane `id` in `root`, or undefined when it has no sibling to sit beside. */
export function placeOf(root: PaneNode | null, id: string): PanePlace | undefined {
  if (root === null || root.kind === 'leaf') return undefined
  const index = root.children.findIndex((child) => child.kind === 'leaf' && child.terminalId === id)
  if (index < 0 || isFileColumn(root)) {
    for (const child of root.children) {
      const found = placeOf(child, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  const sibling = root.children[index - 1] ?? root.children[index + 1]
  if (sibling === undefined) return undefined
  return { beside: terminalIdsIn(sibling), direction: root.direction, before: index === 0 }
}

/**
 * Puts pane `id` back at `place`: beside the sibling in a split of that direction, taking half
 * the sibling's share; else dividing the first of the sibling's panes still open. Null when none is.
 */
export function insertBeside(root: PaneNode | null, place: PanePlace, id: string): PaneNode | null {
  if (root === null) return null
  const beside = new Set(place.beside)
  const isSibling = (node: PaneNode): boolean => {
    const ids = terminalIdsIn(node)
    return ids.length > 0 && ids.every((each) => beside.has(each))
  }
  const pair = (node: PaneNode): PaneNode[] => (place.before ? [leafPane(id), node] : [node, leafPane(id)])

  let placed = false
  const within = (node: PaneNode): PaneNode => {
    if (placed || node.kind === 'leaf') return node
    const index = isFileColumn(node) || node.direction !== place.direction ? -1 : node.children.findIndex(isSibling)
    if (index < 0) return { ...node, children: node.children.map(within) }
    placed = true
    const sizes = normaliseSizes(node.sizes, node.children.length)
    const half = (sizes[index] ?? 0) / 2
    return {
      ...node,
      children: node.children.flatMap((child, at) => (at === index ? pair(child) : [child])),
      sizes: sizes.flatMap((size, at) => (at === index ? [half, half] : [size]))
    }
  }
  const target = terminalIdsIn(root).find((each) => beside.has(each))
  const divided = (node: PaneNode): PaneNode => {
    if ((node.kind === 'leaf' || isFileColumn(node)) && target !== undefined && containsTerminal(node, target)) {
      return { kind: 'split', direction: place.direction, sizes: [0.5, 0.5], children: pair(node) }
    }
    return node.kind === 'leaf' ? node : { ...node, children: node.children.map(divided) }
  }

  const next = within(root)
  if (placed) return normalisePane(next)
  return target === undefined ? null : normalisePane(divided(root))
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
  // Nothing usable came in: split evenly.
  if (total <= 0) return cleaned.map(() => 1 / count)
  return cleaned.map((value) => value / total)
}

/** Canonicalises a subtree: flattens same-direction nesting, collapses single-child splits, normalises sizes. */
export function normalisePane(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node
  if (isFileColumn(node)) return withTabs(node, node.children)

  const children: PaneNode[] = []
  const sizes: number[] = []
  const parentSizes = normaliseSizes(node.sizes, node.children.length)

  node.children.forEach((child, index) => {
    const normalised = normalisePane(child)
    const slot = parentSizes[index] ?? 0
    if (normalised.kind === 'split' && normalised.direction === node.direction && !isFileColumn(normalised)) {
      // A row inside a row draws identically to one wider row.
      normalised.children.forEach((grandchild, inner) => {
        children.push(grandchild)
        sizes.push(slot * (normalised.sizes[inner] ?? 0))
      })
      return
    }
    children.push(normalised)
    sizes.push(slot)
  })

  // A childless split is not a layout at all: fail loudly rather than invent a pane.
  if (children.length === 0) throw new Error('pane split has no children')
  const only = children[0]
  if (children.length === 1 && only !== undefined) return only
  return { kind: 'split', direction: node.direction, sizes: normaliseSizes(sizes, children.length), children }
}

/** Validates an untrusted tree and returns a canonical copy, or null. Ids are checked for shape only. */
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
    if (typeof node.terminalId !== 'string' || node.terminalId.length === 0) return null
    // A file leaf keeps its path, commit, compare and review; every other `pane` value is a terminal.
    if (node.pane === 'file') {
      if (typeof node.path !== 'string' || node.path.length === 0) return null
      if (typeof node.commit === 'string' && node.commit.length > 0) {
        return commitLeaf(node.terminalId, node.commit, node.path)
      }
      if (typeof node.compare === 'string' && node.compare.length > 0) {
        return compareLeaf(node.terminalId, node.compare, node.path)
      }
      if (node.review === true) return reviewLeaf(node.terminalId, node.path)
      if (typeof node.sharedNote === 'string' && node.sharedNote.length > 0) {
        return sharedNoteLeaf(node.terminalId, node.sharedNote, node.path)
      }
      return fileLeaf(node.terminalId, node.path)
    }
    return leafPane(node.terminalId)
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
  const split: PaneNode = {
    kind: 'split',
    direction: node.direction,
    sizes: normaliseSizes(sizes, children.length),
    children
  }
  if (node.tabs !== true || !children.every(isFileLeaf)) return split
  const preview = typeof node.preview === 'string' ? { preview: node.preview } : {}
  return withTabs(
    { ...split, tabs: true, ...preview },
    children,
    typeof node.shown === 'string' ? node.shown : undefined
  )
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

    if ((child.kind === 'leaf' || isFileColumn(child)) && containsTerminal(child, targetTerminalId)) {
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
