// Where a dragged tab lands: the third of a pane the pointer is in, the gap between two tabs, and what
// the tree becomes when it is let go there.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { fileLeaf, withTabs } from '@shared/filePane'
import { arranged, dropEdge, edgeArea, gapAt } from './paneDrag'
import { collectTerminalIds, leaf } from './paneLayout'

const box = { x: 100, y: 50, width: 300, height: 600 }

describe('dropEdge', () => {
  it.each([
    [110, 350, 'left'],
    [390, 350, 'right'],
    [250, 60, 'top'],
    [250, 640, 'bottom'],
    [250, 350, 'center'],
    // A corner goes to the nearer side, measured against each side's own length.
    [105, 70, 'left'],
    [140, 55, 'top']
  ] as const)('reads (%i, %i) as %s', (x, y, edge) => {
    expect(dropEdge(box, x, y)).toBe(edge)
  })
})

describe('edgeArea', () => {
  it('shades the half the pane would take, or all of it for a swap', () => {
    expect(edgeArea(box, 'left')).toEqual({ x: 100, y: 50, width: 150, height: 600 })
    expect(edgeArea(box, 'right')).toEqual({ x: 250, y: 50, width: 150, height: 600 })
    expect(edgeArea(box, 'top')).toEqual({ x: 100, y: 50, width: 300, height: 300 })
    expect(edgeArea(box, 'bottom')).toEqual({ x: 100, y: 350, width: 300, height: 300 })
    expect(edgeArea(box, 'center')).toEqual(box)
  })
})

describe('gapAt', () => {
  const tabs = [0, 100, 200].map((x) => ({ x, y: 0, width: 100, height: 30 }))
  it('counts the tabs whose middle is left of the pointer', () => {
    expect(gapAt(tabs, -5)).toBe(0)
    expect(gapAt(tabs, 49)).toBe(0)
    expect(gapAt(tabs, 51)).toBe(1)
    expect(gapAt(tabs, 260)).toBe(3)
  })
})

describe('arranged', () => {
  const files = withTabs(
    { kind: 'split', direction: 'column', sizes: [], children: [], tabs: true },
    [fileLeaf('f1', 'a.ts'), fileLeaf('f2', 'b.ts')],
    'f1'
  )
  const root: PaneNode = { kind: 'split', direction: 'row', sizes: [0.5, 0.5], children: [leaf('t'), files] }

  it('reorders the strip, moves a pane to an edge, and takes a tab out', () => {
    const stop = { kind: 'stop', id: 't', label: 't' } as const
    expect(collectTerminalIds(arranged(root, stop, { kind: 'strip', index: 1 }))).toEqual(['f1', 'f2', 't'])
    expect(collectTerminalIds(arranged(root, stop, { kind: 'pane', id: 'f1', edge: 'right' }))).toEqual([
      'f1',
      'f2',
      't'
    ])
    const tab = { kind: 'tab', id: 'f2', label: 'b.ts' } as const
    expect(collectTerminalIds(arranged(root, tab, { kind: 'pane', id: 't', edge: 'left' }))).toEqual(['f2', 't', 'f1'])
    expect(collectTerminalIds(arranged(root, tab, { kind: 'tabs', index: 0 }))).toEqual(['t', 'f2', 'f1'])
  })

  it('gives the same tree back where the drop means nothing', () => {
    const tab = { kind: 'tab', id: 'f2', label: 'b.ts' } as const
    expect(arranged(root, tab, { kind: 'strip', index: 0 })).toBe(root)
    expect(arranged(root, { kind: 'stop', id: 't', label: 't' }, { kind: 'tabs', index: 0 })).toBe(root)
    // The column's strip entry names its shown tab, and is the column, not that tab.
    expect(arranged(root, { kind: 'stop', id: 'f2', label: 'b.ts' }, { kind: 'tabs', index: 0 })).toBe(root)
  })
})
