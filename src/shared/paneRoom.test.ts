import { describe, expect, it } from 'vitest'
import type { PaneNode } from './entities'
import {
  leavesRoom,
  minExtent,
  PANE_BAR_PX,
  PANE_CHROME,
  PANE_GUTTER_PX,
  paneCellsIn,
  paneRects,
  placePane,
  placePaneWithin
} from './paneRoom'

const leaf = (id: string): PaneNode => ({ kind: 'leaf', terminalId: id })

function grow(count: number, box: { width: number; height: number }): PaneNode | null {
  let root: PaneNode | null = null
  for (let i = 0; i < count; i++) root = placePane(root, leaf(`t${i}`), box)
  return root
}

/** Distinct left edges and top edges: the grid's columns and rows. */
function grid(root: PaneNode | null, box: { width: number; height: number }): { cols: number; rows: number } {
  const rects = paneRects(root, box)
  const round = (value: number): number => Math.round(value)
  return {
    cols: new Set(rects.map((rect) => round(rect.x))).size,
    rows: new Set(rects.map((rect) => round(rect.y))).size
  }
}

describe('paneRects', () => {
  it('lays each leaf out in reading order, gutters off first', () => {
    const root: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        leaf('a'),
        { kind: 'split', direction: 'column', sizes: [0.25, 0.75], children: [leaf('b'), leaf('c')] }
      ]
    }
    expect(paneRects(root, { width: 210, height: 410 }, 10)).toEqual([
      { id: 'a', x: 0, y: 0, width: 100, height: 410 },
      { id: 'b', x: 110, y: 0, width: 100, height: 100 },
      { id: 'c', x: 110, y: 110, width: 100, height: 300 }
    ])
  })
})

describe('placePane', () => {
  const landscape = { width: 1000, height: 800 }

  it('gives the first pane everything', () => {
    expect(placePane(null, leaf('a'), landscape)).toEqual(leaf('a'))
  })

  it('makes four panes a 2x2 grid', () => {
    expect(grid(grow(4, landscape), landscape)).toEqual({ cols: 2, rows: 2 })
    expect(grid(grow(4, { width: 1600, height: 1000 }), { width: 1600, height: 1000 })).toEqual({ cols: 2, rows: 2 })
    expect(grid(grow(4, { width: 700, height: 1000 }), { width: 700, height: 1000 })).toEqual({ cols: 2, rows: 2 })
  })

  it('makes nine panes 3x3 and twelve 4x3, every pane the same size', () => {
    for (const [count, cols, rows] of [
      [9, 3, 3],
      [12, 4, 3]
    ] as const) {
      const root = grow(count, landscape)
      expect(grid(root, landscape)).toEqual({ cols, rows })
      for (const rect of paneRects(root, landscape)) {
        expect(rect.width).toBeCloseTo((landscape.width - PANE_GUTTER_PX * (cols - 1)) / cols)
        expect(rect.height).toBeCloseTo((landscape.height - PANE_GUTTER_PX * (rows - 1)) / rows)
      }
    }
  })

  it('never stretches into a line of slivers', () => {
    const wide = { width: 1600, height: 1000 }
    for (const rect of paneRects(grow(12, wide), wide)) {
      expect(rect.width).toBeGreaterThanOrEqual(wide.width / 5)
      expect(rect.height).toBeGreaterThanOrEqual(wide.height / 4)
    }
  })

  it('splits the largest pane along its longer side', () => {
    const lopsided: PaneNode = { kind: 'split', direction: 'row', sizes: [0.8, 0.2], children: [leaf('a'), leaf('b')] }
    expect(placePane(lopsided, leaf('n'), { width: 1000, height: 1000 })).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.8, 0.2],
      children: [{ kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('a'), leaf('n')] }, leaf('b')]
    })
  })
})

describe('placePaneWithin', () => {
  const box = { width: 800, height: 400 }

  it('refuses when every place would leave a pane under the minimum', () => {
    expect(placePaneWithin(leaf('a'), leaf('n'), box, { width: 500, height: 300 })).toBeNull()
  })

  it('takes the shorter side when the longer one has no room', () => {
    const placed = placePaneWithin(leaf('a'), leaf('n'), box, { width: 500, height: 150 })
    expect(placed).toMatchObject({ kind: 'split', direction: 'column' })
  })

  it('always places the first pane', () => {
    expect(placePaneWithin(null, leaf('a'), { width: 10, height: 10 }, { width: 500, height: 300 })).toEqual(leaf('a'))
  })
})

describe('leavesRoom', () => {
  const min = { width: 300, height: 100 }
  const box = { width: 1000, height: 400 }

  it('holds a pane only to the sides it lost', () => {
    const before: PaneNode = { kind: 'split', direction: 'column', sizes: [0.9, 0.1], children: [leaf('a'), leaf('b')] }
    // `b` was already short; splitting `a` beside it takes nothing from it.
    const after: PaneNode = {
      kind: 'split',
      direction: 'column',
      sizes: [0.9, 0.1],
      children: [{ kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('n')] }, leaf('b')]
    }
    expect(leavesRoom(before, after, box, min)).toBe(true)
    expect(leavesRoom(before, after, { width: 500, height: 400 }, min)).toBe(false)
  })
})

describe('minExtent', () => {
  const min = { width: 300, height: 100 }
  const tree: PaneNode = {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [leaf('a'), { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('b'), leaf('c')] }]
  }

  it('adds up panes side by side and takes the widest of a stack', () => {
    expect(minExtent(tree, 'row', min, 5)).toBe(605)
    expect(minExtent(tree, 'column', min, 5)).toBe(205)
  })
})

describe('a file column', () => {
  const file = (id: string): PaneNode => ({ kind: 'leaf', terminalId: id, pane: 'file', path: `${id}.ts` })
  const column = (...ids: string[]): PaneNode => ({
    kind: 'split',
    direction: 'column',
    sizes: ids.map(() => 1 / ids.length),
    children: ids.map(file),
    tabs: true,
    shown: ids[0]!
  })
  const box = { width: 1005, height: 400 }
  const tree: PaneNode = {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [leaf('t'), column('f1', 'f2')]
  }

  it('gives every tab the whole column', () => {
    expect(paneRects(tree, box).slice(1)).toEqual([
      { id: 'f1', x: 505, y: 0, width: 500, height: 400 },
      { id: 'f2', x: 505, y: 0, width: 500, height: 400 }
    ])
  })

  it('needs the room of one pane, however many tabs it holds', () => {
    expect(minExtent(column('f1', 'f2', 'f3'), 'column', { width: 300, height: 100 }, 5)).toBe(100)
  })

  it('takes a new pane beside itself, never among its tabs', () => {
    const placed = placePane(column('f1', 'f2'), leaf('n'), { width: 1000, height: 400 })
    expect(placed).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [column('f1', 'f2'), leaf('n')]
    })
  })
})

describe('paneCellsIn', () => {
  const box = { width: 1000, height: 800 }
  const cell = { width: 8, height: 16 }

  it('counts the cells left in a pane once its chrome is off, as the fit addon does', () => {
    const halves: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] }
    expect(paneCellsIn(halves, 'b', box, cell)).toEqual({
      cols: Math.floor(((1000 - PANE_GUTTER_PX) / 2 - PANE_CHROME.width) / 8),
      rows: Math.floor((800 - PANE_CHROME.height) / 16)
    })
  })

  it('gives a lone pane the rows its missing bar would have taken', () => {
    expect(paneCellsIn(leaf('a'), 'a', box, cell)?.rows).toBe(Math.floor((800 - PANE_CHROME.height + PANE_BAR_PX) / 16))
  })

  it('answers nothing for a pane that is not in the tree', () => {
    expect(paneCellsIn(leaf('a'), 'b', box, cell)).toBeUndefined()
  })
})
