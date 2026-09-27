// Where a dragged tab lands: the third of a pane the pointer is in, the gap between two tabs, and what
// the tree becomes when it is let go there.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { fileLeaf, withTabs } from '@shared/filePane'
import { arranged, dropEdge, edgeArea, gapAt, zoneMark } from './paneDrag'
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
  it('shades the half the pane would take, or all of it to join its tabs', () => {
    expect(edgeArea(box, 'left')).toEqual({ x: 100, y: 50, width: 150, height: 600 })
    expect(edgeArea(box, 'right')).toEqual({ x: 250, y: 50, width: 150, height: 600 })
    expect(edgeArea(box, 'top')).toEqual({ x: 100, y: 50, width: 300, height: 300 })
    expect(edgeArea(box, 'bottom')).toEqual({ x: 100, y: 350, width: 300, height: 300 })
    expect(edgeArea(box, 'center')).toEqual(box)
  })
})

describe('zoneMark', () => {
  it('stands a split zone in from the pane, half as far on the side the pane keeps', () => {
    expect(zoneMark(box, 'right')).toEqual({ x: 256, y: 62, width: 132, height: 576 })
    expect(zoneMark(box, 'top')).toEqual({ x: 112, y: 62, width: 276, height: 282 })
  })

  it('draws joining the tabs as a card in the middle', () => {
    const card = zoneMark(box, 'center')
    expect(card.x + card.width / 2).toBe(250)
    expect(card.y + card.height / 2).toBe(350)
    expect(card.width).toBeLessThan(box.width)
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

  it('reorders a group, moves a tab into another, out to an edge, and moves a lone pane whole', () => {
    const tab = { id: 'f2', label: 'b.ts' }
    expect(collectTerminalIds(arranged(root, tab, { kind: 'tabs', group: 'f1', index: 0 }))).toEqual(['t', 'f2', 'f1'])
    expect(collectTerminalIds(arranged(root, tab, { kind: 'tabs', group: 't', index: 0 }))).toEqual(['f2', 't', 'f1'])
    expect(collectTerminalIds(arranged(root, tab, { kind: 'pane', id: 't', edge: 'left' }))).toEqual(['f2', 't', 'f1'])
    const lone = { id: 't', label: 't' }
    expect(collectTerminalIds(arranged(root, lone, { kind: 'pane', id: 'f1', edge: 'right' }))).toEqual([
      'f1',
      'f2',
      't'
    ])
    expect(collectTerminalIds(arranged(root, lone, { kind: 'pane', id: 'f1', edge: 'center' }))).toEqual([
      'f1',
      'f2',
      't'
    ])
  })

  it('gives the same tree back where the drop means nothing', () => {
    expect(arranged(root, { id: 'f1', label: 'a.ts' }, { kind: 'tabs', group: 'f2', index: 0 })).toBe(root)
    expect(arranged(root, { id: 'f2', label: 'b.ts' }, { kind: 'pane', id: 'f1', edge: 'center' })).toBe(root)
    expect(arranged(root, { id: 't', label: 't' }, { kind: 'pane', id: 't', edge: 'left' })).toBe(root)
  })
})
