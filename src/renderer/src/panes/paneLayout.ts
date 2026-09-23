// Pure operations over the PaneNode split tree. Everything here is total and
// side-effect free so the layout can be reasoned about (and tested) without a
// DOM: the components below only translate the results into CSS.

import type { PaneNode } from '@shared/entities'
import { PANE_GUTTER_PX } from '@shared/paneRoom'

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

/** `splitPane` for a leaf built by the caller, which is how a file pane arrives. */
export function splitPaneWith(
  root: PaneNode | null,
  terminalId: string,
  direction: 'row' | 'column',
  added: PaneNode
): PaneNode {
  if (!root) return added
  if (root.kind === 'leaf') {
    return root.terminalId === terminalId
      ? { kind: 'split', direction, sizes: [0.5, 0.5], children: [root, added] }
      : root
  }

  const index = root.children.findIndex((child) => child.kind === 'leaf' && child.terminalId === terminalId)
  if (index !== -1 && root.direction === direction) {
    const sizes = normalizeSizes(root.sizes, root.children.length)
    const share = sizes[index] ?? 1 / sizes.length
    const children = [...root.children]
    children.splice(index + 1, 0, added)
    const nextSizes = [...sizes]
    nextSizes.splice(index, 1, share / 2, share / 2)
    return { kind: 'split', direction: root.direction, sizes: normalizeSizes(nextSizes, children.length), children }
  }

  return {
    kind: 'split',
    direction: root.direction,
    sizes: normalizeSizes(root.sizes, root.children.length),
    children: root.children.map((child) => splitPaneWith(child, terminalId, direction, added))
  }
}

/** Adds a pane at the top level, the way the runtime's `terminal.create` does. */
export function appendPane(root: PaneNode | null, added: PaneNode, direction: 'row' | 'column' = 'row'): PaneNode {
  if (!root) return added
  if (root.kind === 'split' && root.direction === direction) {
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
  if (kept.length === 1) return kept[0] ?? null
  return { kind: 'split', direction: root.direction, sizes: normalizeSizes(keptSizes, kept.length), children: kept }
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
  return collectLeaves(root).find((node) => node.terminalId === expandedTerminalId) ?? root
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
