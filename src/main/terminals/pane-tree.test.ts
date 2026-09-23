import { describe, expect, it } from 'vitest'
import type { PaneNode } from '../../shared/entities'
import {
  appendPane,
  containsTerminal,
  leafPane,
  normalisePane,
  normaliseSizes,
  parsePaneNode,
  removePane,
  splitPane,
  terminalIdsIn
} from './pane-tree'

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** Every returned tree has to satisfy the module's stated invariants. */
function expectWellFormed(node: PaneNode | null): void {
  if (node === null || node.kind === 'leaf') return
  expect(node.children.length).toBeGreaterThanOrEqual(2)
  expect(node.sizes).toHaveLength(node.children.length)
  expect(sum(node.sizes)).toBeCloseTo(1, 10)
  for (const child of node.children) {
    expect(child.kind === 'split' && child.direction === node.direction).toBe(false)
    expectWellFormed(child)
  }
}

describe('splitPane', () => {
  it('turns a lone pane into an even two-pane split', () => {
    const root = splitPane(leafPane('a'), 'a', 'row', 'b')
    expect(root).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leafPane('a'), leafPane('b')]
    })
    expectWellFormed(root)
  })

  it('seeds an empty layout with the new pane', () => {
    expect(splitPane(null, 'missing', 'row', 'first')).toEqual(leafPane('first'))
  })

  it('adds a sibling instead of nesting when the direction matches', () => {
    const twoPanes = splitPane(leafPane('a'), 'a', 'row', 'b')
    const threePanes = splitPane(twoPanes, 'b', 'row', 'c')

    expect(terminalIdsIn(threePanes)).toEqual(['a', 'b', 'c'])
    expect(threePanes.kind).toBe('split')
    if (threePanes.kind !== 'split') return
    // 'b' gave away half of its half.
    expect(threePanes.sizes).toEqual([0.5, 0.25, 0.25])
    expectWellFormed(threePanes)
  })

  it('nests when the direction differs, taking only the target pane', () => {
    const row = splitPane(leafPane('a'), 'a', 'row', 'b')
    const nested = splitPane(row, 'b', 'column', 'c')

    expect(nested).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leafPane('a'),
        { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leafPane('b'), leafPane('c')] }
      ]
    })
    expectWellFormed(nested)
  })

  it('splits a pane nested several levels down', () => {
    let root: PaneNode = leafPane('a')
    root = splitPane(root, 'a', 'row', 'b')
    root = splitPane(root, 'b', 'column', 'c')
    root = splitPane(root, 'c', 'row', 'd')

    expect(terminalIdsIn(root)).toEqual(['a', 'b', 'c', 'd'])
    expect(containsTerminal(root, 'd')).toBe(true)
    expectWellFormed(root)
  })

  it('falls back to appending when the target pane is unknown', () => {
    const root = splitPane(leafPane('a'), 'ghost', 'column', 'b')
    expect(terminalIdsIn(root)).toEqual(['a', 'b'])
    expectWellFormed(root)
  })
})

describe('appendPane', () => {
  it('keeps relative sizes when widening an existing row', () => {
    const row: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.8, 0.2],
      children: [leafPane('a'), leafPane('b')]
    }
    const widened = appendPane(row, 'c', 'row')

    expect(widened.kind).toBe('split')
    if (widened.kind !== 'split') return
    expect(widened.sizes[0]).toBeCloseTo(0.8 * (2 / 3), 10)
    expect(widened.sizes[1]).toBeCloseTo(0.2 * (2 / 3), 10)
    expect(widened.sizes[2]).toBeCloseTo(1 / 3, 10)
    // The ratio between the original panes is untouched.
    expect((widened.sizes[0] ?? 0) / (widened.sizes[1] ?? 1)).toBeCloseTo(4, 10)
    expectWellFormed(widened)
  })

  it('starts a layout from nothing', () => {
    expect(appendPane(null, 'a')).toEqual(leafPane('a'))
  })
})

describe('removePane', () => {
  it('empties the tree when the last pane goes', () => {
    expect(removePane(leafPane('a'), 'a')).toBeNull()
  })

  it('leaves an unrelated tree alone', () => {
    const root = splitPane(leafPane('a'), 'a', 'row', 'b')
    expect(removePane(root, 'ghost')).toEqual(root)
  })

  it('collapses a two-pane split back into a plain pane', () => {
    const root = splitPane(leafPane('a'), 'a', 'row', 'b')
    expect(removePane(root, 'b')).toEqual(leafPane('a'))
  })

  it('renormalises the survivors of a three-pane split', () => {
    let root: PaneNode = leafPane('a')
    root = splitPane(root, 'a', 'row', 'b')
    root = splitPane(root, 'b', 'row', 'c')

    const remaining = removePane(root, 'a')
    expect(terminalIdsIn(remaining)).toEqual(['b', 'c'])
    expect(remaining?.kind).toBe('split')
    if (remaining?.kind !== 'split') return
    // b and c were 0.25 each; equal shares survive as equal shares.
    expect(remaining.sizes).toEqual([0.5, 0.5])
    expectWellFormed(remaining)
  })

  it('collapses a nested split and flattens it into its parent', () => {
    // row[a, column[b, row[c, d]]] -> removing b hoists row[c, d] into the outer
    // row, which must flatten rather than leave a row inside a row.
    let root: PaneNode = leafPane('a')
    root = splitPane(root, 'a', 'row', 'b')
    root = splitPane(root, 'b', 'column', 'c')
    root = splitPane(root, 'c', 'row', 'd')

    const collapsed = removePane(root, 'b')
    expect(terminalIdsIn(collapsed)).toEqual(['a', 'c', 'd'])
    expect(collapsed?.kind).toBe('split')
    if (collapsed?.kind !== 'split') return
    expect(collapsed.direction).toBe('row')
    expect(collapsed.children.every((child) => child.kind === 'leaf')).toBe(true)
    expect(collapsed.sizes).toEqual([0.5, 0.25, 0.25])
    expectWellFormed(collapsed)
  })

  it('removes panes one by one down to nothing', () => {
    let root: PaneNode | null = leafPane('a')
    root = splitPane(root, 'a', 'row', 'b')
    root = splitPane(root, 'b', 'column', 'c')

    root = removePane(root, 'a')
    expectWellFormed(root)
    root = removePane(root, 'c')
    expect(root).toEqual(leafPane('b'))
    root = removePane(root, 'b')
    expect(root).toBeNull()
    expect(removePane(root, 'b')).toBeNull()
  })
})

describe('normaliseSizes', () => {
  it('scales any positive weights to sum to 1', () => {
    expect(normaliseSizes([2, 2], 2)).toEqual([0.5, 0.5])
    expect(sum(normaliseSizes([1, 2, 7], 3))).toBeCloseTo(1, 10)
  })

  it('splits evenly when nothing usable arrives', () => {
    expect(normaliseSizes([], 4)).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(normaliseSizes([0, 0], 2)).toEqual([0.5, 0.5])
    expect(normaliseSizes([Number.NaN, Number.POSITIVE_INFINITY], 2)).toEqual([0.5, 0.5])
  })

  it('matches the child count, padding or truncating', () => {
    expect(normaliseSizes([0.5, 0.5], 3)).toEqual([0.5, 0.5, 0])
    expect(normaliseSizes([1, 1, 1, 1], 2)).toEqual([0.5, 0.5])
  })

  it('has no sizes for no children', () => {
    expect(normaliseSizes([1], 0)).toEqual([])
  })
})

describe('normalisePane', () => {
  it('flattens same-direction nesting while preserving proportions', () => {
    const nested: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leafPane('a'),
        { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leafPane('b'), leafPane('c')] }
      ]
    }
    expect(normalisePane(nested)).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.25, 0.25],
      children: [leafPane('a'), leafPane('b'), leafPane('c')]
    })
  })

  it('replaces a one-child split with its child', () => {
    const lonely: PaneNode = {
      kind: 'split',
      direction: 'column',
      sizes: [1],
      children: [leafPane('a')]
    }
    expect(normalisePane(lonely)).toEqual(leafPane('a'))
  })

  it('rejects a split with no children at all', () => {
    expect(() => normalisePane({ kind: 'split', direction: 'row', sizes: [], children: [] })).toThrow()
  })
})

describe('parsePaneNode', () => {
  it('accepts a well-formed tree and normalises its sizes', () => {
    const parsed = parsePaneNode({
      kind: 'split',
      direction: 'column',
      sizes: [3, 1],
      children: [
        { kind: 'leaf', terminalId: 'a' },
        { kind: 'leaf', terminalId: 'b' }
      ]
    })
    expect(parsed).toEqual({
      kind: 'split',
      direction: 'column',
      sizes: [0.75, 0.25],
      children: [leafPane('a'), leafPane('b')]
    })
  })

  it('repairs missing sizes rather than rejecting the tree', () => {
    const parsed = parsePaneNode({
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'leaf', terminalId: 'a' },
        { kind: 'leaf', terminalId: 'b' }
      ]
    })
    expect(parsed).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leafPane('a'), leafPane('b')]
    })
  })

  it('rejects anything that is not a pane tree', () => {
    expect(parsePaneNode(null)).toBeNull()
    expect(parsePaneNode('leaf')).toBeNull()
    expect(parsePaneNode({ kind: 'leaf' })).toBeNull()
    expect(parsePaneNode({ kind: 'leaf', terminalId: '' })).toBeNull()
    expect(parsePaneNode({ kind: 'branch', children: [] })).toBeNull()
    expect(
      parsePaneNode({ kind: 'split', direction: 'diagonal', children: [{ kind: 'leaf', terminalId: 'a' }] })
    ).toBeNull()
    expect(parsePaneNode({ kind: 'split', direction: 'row', children: [] })).toBeNull()
    expect(parsePaneNode({ kind: 'split', direction: 'row', children: [{ kind: 'leaf' }] })).toBeNull()
  })

  it('refuses a tree too deep to be real', () => {
    let deep: unknown = { kind: 'leaf', terminalId: 'a' }
    for (let i = 0; i < 200; i++) {
      deep = { kind: 'split', direction: 'row', sizes: [1], children: [deep] }
    }
    expect(parsePaneNode(deep)).toBeNull()
  })
})

describe('file leaves', () => {
  const file: PaneNode = { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'docs/NOTES.md' }

  it('round-trips a file leaf and a legacy leaf without `pane` through the untrusted parser', () => {
    const root = parsePaneNode({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [{ kind: 'leaf', terminalId: 'a' }, file]
    })
    expect(root).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leafPane('a'), file]
    })
    expectWellFormed(root)
  })

  it('drops the file fields a leaf cannot honour, and refuses a file leaf with no path', () => {
    expect(parsePaneNode({ kind: 'leaf', terminalId: 'a', pane: 'terminal' })).toEqual(leafPane('a'))
    expect(parsePaneNode({ kind: 'leaf', terminalId: 'a', pane: 'video', path: 'x' })).toEqual(leafPane('a'))
    expect(parsePaneNode({ kind: 'leaf', terminalId: 'file:1', pane: 'file' })).toBeNull()
    expect(parsePaneNode({ kind: 'leaf', terminalId: 'file:1', pane: 'file', path: '' })).toBeNull()
  })

  it('keeps a file leaf through a split and a removal beside it', () => {
    const split = splitPane(file, 'file:1', 'column', 'b')
    expect(split).toEqual({
      kind: 'split',
      direction: 'column',
      sizes: [0.5, 0.5],
      children: [file, leafPane('b')]
    })
    expect(removePane(split, 'b')).toEqual(file)
    expect(terminalIdsIn(split)).toEqual(['file:1', 'b'])
  })
})
