import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { fileColumn, fileLeaf, type FileColumn } from '@shared/filePane'
import { paneRects } from '@shared/paneRoom'
import {
  addTab,
  appendPane,
  applyGutterDrag,
  splitPaneWith,
  closePane,
  collectTerminalIds,
  leaf,
  MIN_PANE_FRACTION,
  neighbourTerminalId,
  normalizeSizes,
  pinTab,
  placeFileColumn,
  setSizesAt,
  showTab,
  shownRoot,
  splitChildBases,
  splitPane
} from './paneLayout'

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

describe('normalizeSizes', () => {
  it('spreads evenly when there is nothing to go on', () => {
    expect(normalizeSizes([], 4)).toEqual([0.25, 0.25, 0.25, 0.25])
  })

  it('pads a short array and rescales to one', () => {
    const sizes = normalizeSizes([0.8], 2)
    expect(sizes).toHaveLength(2)
    expect(sum(sizes)).toBeCloseTo(1)
  })

  it('drops entries beyond the child count', () => {
    expect(normalizeSizes([0.2, 0.3, 0.5], 2)).toHaveLength(2)
  })

  it('replaces corrupt entries rather than collapsing a pane', () => {
    const sizes = normalizeSizes([Number.NaN, -1, 0.5], 3)
    expect(sum(sizes)).toBeCloseTo(1)
    for (const size of sizes) expect(size).toBeGreaterThan(0)
  })

  it('lifts anything below the floor and still sums to one', () => {
    const sizes = normalizeSizes([0.99, 0.01], 2)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(MIN_PANE_FRACTION - 1e-9)
    expect(sum(sizes)).toBeCloseTo(1)
  })

  it('cannot satisfy a floor that does not fit, so it falls back to even shares', () => {
    const sizes = normalizeSizes([0.5, 0.3, 0.2], 3, 0.9)
    expect(sum(sizes)).toBeCloseTo(1)
    expect(sizes[0]).toBeCloseTo(1 / 3)
  })
})

describe('applyGutterDrag', () => {
  it('moves only the two panes either side of the handle', () => {
    const sizes = applyGutterDrag([0.25, 0.25, 0.5], 0, 100, 1000)
    expect(sizes[0]).toBeCloseTo(0.35)
    expect(sizes[1]).toBeCloseTo(0.15)
    expect(sizes[2]).toBeCloseTo(0.5)
  })

  it('clamps at the floor instead of eliminating a pane', () => {
    const sizes = applyGutterDrag([0.5, 0.5], 0, 10000, 1000)
    expect(sizes[1]).toBeCloseTo(MIN_PANE_FRACTION)
    expect(sum(sizes)).toBeCloseTo(1)
  })

  it('clamps in the other direction too', () => {
    const sizes = applyGutterDrag([0.5, 0.5], 0, -10000, 1000)
    expect(sizes[0]).toBeCloseTo(MIN_PANE_FRACTION)
  })

  it('is inert without a measured container', () => {
    expect(applyGutterDrag([0.5, 0.5], 0, 120, 0)).toEqual([0.5, 0.5])
  })

  it('stops each side at its own least size in pixels', () => {
    const sizes = applyGutterDrag([0.5, 0.5], 0, 10000, 1000, [100, 350])
    expect(sizes[1]).toBeCloseTo(0.35)
    expect(applyGutterDrag([0.5, 0.5], 0, -10000, 1000, [100, 350])[0]).toBeCloseTo(0.1)
  })

  it('lets a pane already under its least size grow but not shrink', () => {
    expect(applyGutterDrag([0.2, 0.8], 0, -50, 1000, [300, 300])).toEqual([0.2, 0.8])
    expect(applyGutterDrag([0.2, 0.8], 0, 50, 1000, [300, 300])[0]).toBeCloseTo(0.25)
  })
})

describe('splitChildBases', () => {
  it('takes the gutters off before dividing the space', () => {
    expect(splitChildBases([0.5, 0.5], 5)).toEqual(['calc((100% - 5px) * 0.5)', 'calc((100% - 5px) * 0.5)'])
  })

  it('accounts for every gutter in a three-way split', () => {
    const bases = splitChildBases([1 / 3, 1 / 3, 1 / 3], 6)
    expect(bases).toHaveLength(3)
    for (const basis of bases) expect(basis).toContain('100% - 12px')
  })
})

describe('splitPane', () => {
  it('turns a lone leaf into a split', () => {
    const root = splitPane(leaf('a'), 'a', 'row', 'b')
    expect(root).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), leaf('b')]
    })
  })

  it('extends the parent when the axis already matches', () => {
    const start: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
    const root = splitPane(start, 'a', 'row', 'c')
    expect(root.kind).toBe('split')
    expect(collectTerminalIds(root)).toEqual(['a', 'c', 'b'])
    if (root.kind === 'split') {
      expect(root.children).toHaveLength(3)
      expect(sum(root.sizes)).toBeCloseTo(1)
      expect(root.sizes[0]).toBeCloseTo(0.25)
    }
  })

  it('nests when the axis differs', () => {
    const start: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
    const root = splitPane(start, 'b', 'column', 'c')
    expect(root.kind).toBe('split')
    if (root.kind === 'split') {
      const nested = root.children[1]
      expect(nested?.kind).toBe('split')
      if (nested?.kind === 'split') expect(nested.direction).toBe('column')
    }
  })

  it('reaches leaves at any depth', () => {
    const start: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }]
    }
    expect(collectTerminalIds(splitPane(start, 'c', 'row', 'd'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('starts a tree from nothing', () => {
    expect(splitPane(null, 'anything', 'row', 'a')).toEqual(leaf('a'))
  })
})

describe('closePane', () => {
  it('empties a single-leaf tree', () => {
    expect(closePane(leaf('a'), 'a')).toBeNull()
  })

  it('dissolves a split left with one child', () => {
    const start: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
    expect(closePane(start, 'b')).toEqual(leaf('a'))
  })

  it('hands the space back to the remaining siblings', () => {
    const start: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.2, 0.3, 0.5],
      children: [leaf('a'), leaf('b'), leaf('c')]
    }
    const root = closePane(start, 'b')
    expect(root?.kind).toBe('split')
    if (root?.kind === 'split') {
      expect(collectTerminalIds(root)).toEqual(['a', 'c'])
      expect(sum(root.sizes)).toBeCloseTo(1)
      expect(root.sizes[1]).toBeGreaterThan(root.sizes[0] ?? 0)
    }
  })

  it('collapses a nested split that loses its last pane', () => {
    const start: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', direction: 'column', sizes: [1], children: [leaf('b')] }]
    }
    expect(closePane(start, 'b')).toEqual(leaf('a'))
  })

  it('leaves the tree alone when the pane is not in it', () => {
    const start: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
    expect(closePane(start, 'zzz')).toEqual(start)
  })
})

describe('setSizesAt', () => {
  it('addresses a nested split by child indices', () => {
    const start: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }]
    }
    const root = setSizesAt(start, [1], [0.7, 0.3])
    if (root.kind === 'split' && root.children[1]?.kind === 'split') {
      expect(root.children[1].sizes[0]).toBeCloseTo(0.7)
    }
    if (root.kind === 'split') expect(root.sizes).toEqual([0.5, 0.5])
  })
})

describe('neighbourTerminalId', () => {
  const tree: PaneNode = {
    kind: 'split',
    direction: 'row',
    sizes: [0.34, 0.33, 0.33],
    children: [leaf('a'), leaf('b'), leaf('c')]
  }

  it('prefers the pane after the one closing', () => {
    expect(neighbourTerminalId(tree, 'b')).toBe('c')
  })

  it('falls back to the pane before when closing the last', () => {
    expect(neighbourTerminalId(tree, 'c')).toBe('b')
  })

  it('has nothing to offer for the only pane', () => {
    expect(neighbourTerminalId(leaf('a'), 'a')).toBeNull()
  })
})

// Maximising, as the tree on its way to the screen. The store holds only an id;
// this is the whole of applying it, which is why it is a function rather than a
// rewrite of the layout — nothing here is saved and nothing is rebuilt to undo.
describe('the tree as it is drawn', () => {
  const tree = splitPane(leaf('t1'), 't1', 'row', 't2')

  it('is the whole tree when nothing is maximised', () => {
    expect(shownRoot(tree, null)).toBe(tree)
    expect(shownRoot(null, null)).toBeNull()
  })

  it('is the one pane when one is', () => {
    expect(shownRoot(tree, 't2')).toEqual({ kind: 'leaf', terminalId: 't2' })
    expect(collectTerminalIds(shownRoot(tree, 't2'))).toEqual(['t2'])
  })

  // The maximised pane has since been closed, or belongs to the worktree that
  // was open a moment ago. An empty workspace is the wrong answer to either.
  it('gives the whole tree back for a pane that is not in it', () => {
    expect(shownRoot(tree, 'gone')).toBe(tree)
    expect(shownRoot(null, 't1')).toBeNull()
  })
})

describe('file leaves in the tree', () => {
  const file: PaneNode = { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'NOTES.md' }

  it('splits beside a pane with a leaf the caller built', () => {
    const root = splitPaneWith(leaf('a'), 'a', 'row', file)
    expect(root).toEqual({ kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), file] })
    expect(collectTerminalIds(root)).toEqual(['a', 'file:1'])
  })

  it('fills the workspace with the file leaf itself, path and all', () => {
    const root = splitPaneWith(leaf('a'), 'a', 'row', file)
    expect(shownRoot(root, 'file:1')).toEqual(file)
  })

  it('appends at the top level, widening a same-direction row', () => {
    expect(appendPane(null, file)).toEqual(file)
    const row = appendPane(appendPane(leaf('a'), leaf('b')), file)
    expect(row.kind).toBe('split')
    if (row.kind !== 'split') return
    expect(row.children).toEqual([leaf('a'), leaf('b'), file])
    expect(row.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10)
    const column = appendPane(row, leaf('c'), 'column')
    expect(column.kind === 'split' && column.direction).toBe('column')
  })
})

describe('the file column', () => {
  const file = (id: string): ReturnType<typeof fileLeaf> => fileLeaf(id, `${id}.ts`)
  const withColumn = (column: FileColumn): PaneNode => ({
    kind: 'split',
    direction: 'row',
    sizes: [0.6, 0.4],
    children: [leaf('t'), column]
  })
  const columnOf = (root: PaneNode): FileColumn => (root.kind === 'split' ? root.children[1] : root) as FileColumn

  it('takes a file as a tab after the one on show, and shows it, leaving the terminal its share', () => {
    let root = withColumn(fileColumn(file('a')))
    root = addTab(root, file('b'))
    root = showTab(root, 'a')
    root = addTab(root, file('c'))
    expect(root.kind === 'split' && root.sizes).toEqual([0.6, 0.4])
    expect(collectTerminalIds(root)).toEqual(['t', 'a', 'c', 'b'])
    expect(columnOf(root).shown).toBe('c')
  })

  it('puts a preview in the preview tab’s place, and pins nothing it was not asked to', () => {
    let root = withColumn(fileColumn(file('a')))
    root = addTab(root, file('p1'), { preview: true })
    expect(columnOf(root).preview).toBe('p1')
    root = addTab(root, file('p2'), { preview: true, replace: 'p1' })
    expect(collectTerminalIds(root)).toEqual(['t', 'a', 'p2'])
    expect(columnOf(root)).toMatchObject({ shown: 'p2', preview: 'p2' })
    root = addTab(root, file('b'))
    expect(columnOf(root).preview).toBe('p2')
  })

  it('pins the preview tab, and changes nothing for any other', () => {
    const root = withColumn(fileColumn(file('a'), true))
    expect(pinTab(root, 'b')).toBe(root)
    expect(columnOf(pinTab(root, 'a')).preview).toBeUndefined()
  })

  it('keeps its last tab, and shows the next one when the shown tab closes', () => {
    let root: PaneNode | null = addTab(addTab(withColumn(fileColumn(file('a'))), file('b')), file('c'))
    root = showTab(root, 'b')
    root = closePane(root, 'b')
    expect(columnOf(root!).shown).toBe('c')
    root = closePane(root, 'c')
    expect(columnOf(root!)).toMatchObject({ tabs: true, children: [file('a')], shown: 'a' })
    expect(closePane(root, 'a')).toEqual(leaf('t'))
  })

  it('is split beside, never into, and nothing is appended among its tabs', () => {
    const column = fileColumn(file('a'))
    const root = withColumn(column)
    const split = splitPaneWith(root, 'a', 'column', file('s'))
    expect(split.kind === 'split' && split.children[1]).toEqual({
      kind: 'split',
      direction: 'column',
      sizes: [0.5, 0.5],
      children: [column, file('s')]
    })
    expect(appendPane(column, leaf('n'), 'column')).toMatchObject({ children: [column, leaf('n')] })
  })
})

describe('where a new file column goes', () => {
  const box = { width: 1100, height: 800 }
  const min = { width: 305, height: 160 }
  const column = fileColumn(fileLeaf('f', 'src/math.ts'))
  const agents = new Set(['claude'])
  const isAgent = (id: string): boolean => agents.has(id)
  const rectOf = (root: PaneNode | null, id: string) => paneRects(root, box).find((rect) => rect.id === id)!
  const split = (direction: 'row' | 'column', sizes: number[], ...children: PaneNode[]): PaneNode => ({
    kind: 'split',
    direction,
    sizes,
    children
  })

  it('goes beside a lone pane and takes half the centre', () => {
    const placed = placeFileColumn(leaf('claude'), column, box, min, isAgent)
    expect(rectOf(placed, 'f').width).toBeGreaterThanOrEqual((box.width - 5) / 2)
    expect(rectOf(placed, 'f').height).toBe(box.height)
  })

  it('goes beside the largest pane, not the first', () => {
    const root = split('row', [0.3, 0.7], leaf('zsh'), leaf('claude'))
    const placed = placeFileColumn(root, column, { width: 1600, height: 800 }, min, isAgent)
    const at = paneRects(placed, { width: 1600, height: 800 })
    const file = at.find((rect) => rect.id === 'f')!
    const claude = at.find((rect) => rect.id === 'claude')!
    expect(file.x).toBeGreaterThan(claude.x)
    expect(file.height).toBe(800)
    expect(file.width).toBeGreaterThanOrEqual(1600 / 2 - 5)
  })

  it('never goes under an agent pane; under a shell when nothing beside has room', () => {
    const root = split('row', [0.5, 0.5], leaf('claude'), split('column', [0.5, 0.5], leaf('zsh1'), leaf('zsh2')))
    const centre = { width: 786, height: 818 }
    const at = paneRects(placeFileColumn(root, column, centre, min, isAgent), centre)
    const was = paneRects(root, centre)
    const find = (rects: typeof at, id: string) => rects.find((rect) => rect.id === id)!
    expect(find(at, 'claude')).toEqual(find(was, 'claude'))
    expect(find(at, 'f').x).toBe(find(was, 'zsh1').x)
    expect(find(at, 'f').y).toBeGreaterThan(find(at, 'zsh1').y)
  })

  it('is refused when no pane can give it room', () => {
    const tiny = { width: 400, height: 200 }
    expect(placeFileColumn(leaf('claude'), column, tiny, min, isAgent)).toBeNull()
  })

  it('is the whole centre in an empty worktree', () => {
    expect(placeFileColumn(null, column, box, min, isAgent)).toBe(column)
  })
})

describe('zooming into the file column', () => {
  const column = fileColumn(fileLeaf('a', 'a.ts'))
  const tree: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('t'), column] }

  it('fills the centre with the whole column, its tabs with it, for a tab in it', () => {
    const withTwo = addTab(tree, fileLeaf('b', 'b.ts'))
    const shown = shownRoot(withTwo, 'a')
    expect(shown?.kind === 'split' && shown.children.map((child) => child.kind === 'leaf' && child.terminalId)).toEqual(
      ['a', 'b']
    )
  })

  it('leaves the tree itself untouched, so restoring is the tree as it was', () => {
    const before = structuredClone(tree)
    shownRoot(tree, 'a')
    expect(tree).toEqual(before)
    expect(shownRoot(tree, null)).toBe(tree)
  })
})
