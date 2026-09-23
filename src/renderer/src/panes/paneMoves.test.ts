// Rearranging the tree: a pane dropped on another pane's edge, two panes swapped, the strip reordered,
// and a file taken out of the column or put back. The file column always moves as one pane.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { fileLeaf, withTabs, type FileColumn } from '@shared/filePane'
import { leaf, movePane, moveTabOut, placeTab, reorderPanes, type DropEdge } from './paneLayout'

const split = (direction: 'row' | 'column', children: PaneNode[], sizes?: number[]): PaneNode => ({
  kind: 'split',
  direction,
  sizes: sizes ?? children.map(() => 1 / children.length),
  children
})
const row = (...children: PaneNode[]): PaneNode => split('row', children)
const col = (...children: PaneNode[]): PaneNode => split('column', children)
const file = (id: string): ReturnType<typeof fileLeaf> => fileLeaf(id, `${id}.ts`)
const column = (...ids: string[]): FileColumn =>
  withTabs({ kind: 'split', direction: 'column', sizes: [], children: [], tabs: true }, ids.map(file), ids[0])

/** The tree as text: `row(a,col(b,c))`, the file column as `[f1 f2]`. */
function shape(node: PaneNode | null): string {
  if (node === null) return 'null'
  if (node.kind === 'leaf') return node.terminalId
  if (node.tabs === true) return `[${node.children.map(shape).join(' ')}]`
  return `${node.direction === 'row' ? 'row' : 'col'}(${node.children.map(shape).join(',')})`
}

const sizesOf = (node: PaneNode): number[] => (node.kind === 'split' ? node.sizes : [])

describe('movePane', () => {
  it.each<[DropEdge, string]>([
    ['left', 'row(b,a,c)'],
    ['right', 'row(b,c,a)'],
    ['top', 'row(b,col(a,c))'],
    ['bottom', 'row(b,col(c,a))']
  ])('puts a pane on the %s of another', (edge, expected) => {
    expect(shape(movePane(row(leaf('a'), leaf('b'), leaf('c')), 'a', 'c', edge))).toBe(expected)
  })

  it('hands the moved pane’s room back and halves the target', () => {
    const moved = movePane(split('row', [leaf('a'), leaf('b'), leaf('c')], [0.5, 0.25, 0.25]), 'a', 'c', 'right')
    expect(shape(moved)).toBe('row(b,c,a)')
    sizesOf(moved).forEach((size, index) => expect(size).toBeCloseTo([0.5, 0.25, 0.25][index]!))
  })

  it('moves into its own sibling, dissolving the split it leaves', () => {
    const root = row(leaf('a'), col(leaf('b'), leaf('c')))
    expect(shape(movePane(root, 'b', 'c', 'bottom'))).toBe('row(a,col(c,b))')
    expect(shape(movePane(root, 'b', 'c', 'right'))).toBe('row(a,c,b)')
    expect(shape(movePane(root, 'a', 'b', 'top'))).toBe('col(a,b,c)')
    expect(shape(movePane(row(leaf('a'), leaf('b')), 'a', 'b', 'bottom'))).toBe('col(b,a)')
  })

  it('swaps two panes on the centre, each taking the other’s place and size', () => {
    const root = split('row', [leaf('a'), col(leaf('b'), leaf('c'))], [0.3, 0.7])
    const swapped = movePane(root, 'a', 'c', 'center')
    expect(shape(swapped)).toBe('row(c,col(b,a))')
    expect(sizesOf(swapped)).toEqual([0.3, 0.7])
  })

  it('moves the file column as one pane, by any of its tabs', () => {
    const files = column('f1', 'f2')
    const moved = movePane(row(leaf('t'), files), 'f2', 't', 'left')
    expect(shape(moved)).toBe('row([f1 f2],t)')
    expect(moved.kind === 'split' && moved.children[0]).toEqual(files)
    expect(shape(movePane(row(leaf('t'), leaf('u'), files), 't', 'f1', 'center'))).toBe('row([f1 f2],u,t)')
  })

  it('leaves the tree as it was for itself, its own column, or an id not in it', () => {
    const root = row(leaf('a'), column('f1', 'f2'))
    expect(movePane(root, 'a', 'a', 'left')).toBe(root)
    expect(movePane(root, 'f1', 'f2', 'right')).toBe(root)
    expect(movePane(root, 'x', 'a', 'right')).toBe(root)
    expect(movePane(root, 'a', 'x', 'right')).toBe(root)
  })
})

describe('moveTabOut', () => {
  it('takes a file out of the column as its own pane beside the target', () => {
    const moved = moveTabOut(row(leaf('t'), column('f1', 'f2')), 'f2', 't', 'left')
    expect(shape(moved)).toBe('row(f2,t,[f1])')
    expect(moved.kind === 'split' && moved.children[2]).toMatchObject({ shown: 'f1' })
  })

  it('goes beside its own column while the column keeps other tabs', () => {
    expect(shape(moveTabOut(row(leaf('t'), column('f1', 'f2')), 'f1', 'f2', 'bottom'))).toBe('row(t,col([f2],f1))')
  })

  it('refuses the column’s last tab onto itself, a centre, and anything not a tab', () => {
    const root = row(leaf('t'), column('f1'))
    const two = row(leaf('t'), column('f1', 'f2'))
    expect(moveTabOut(root, 'f1', 'f1', 'right')).toBe(root)
    expect(moveTabOut(two, 'f1', 't', 'center')).toBe(two)
    expect(moveTabOut(root, 't', 'f1', 'left')).toBe(root)
  })
})

describe('reorderPanes', () => {
  it('reorders the strip by moving panes between places, which keep their sizes', () => {
    const moved = reorderPanes(split('row', [leaf('a'), leaf('b'), leaf('c')], [0.5, 0.3, 0.2]), 'c', 0)
    expect(shape(moved)).toBe('row(c,a,b)')
    expect(sizesOf(moved)).toEqual([0.5, 0.3, 0.2])
  })

  it('keeps the tree’s shape, the column one place', () => {
    expect(shape(reorderPanes(row(leaf('a'), col(leaf('b'), leaf('c'))), 'a', 2))).toBe('row(b,col(c,a))')
    expect(shape(reorderPanes(row(leaf('t'), column('f1', 'f2'), leaf('u')), 'f2', 0))).toBe('row([f1 f2],t,u)')
  })

  it('clamps the index, and gives the same tree back for no move', () => {
    const root = row(leaf('a'), leaf('b'))
    expect(shape(reorderPanes(root, 'a', 9))).toBe('row(b,a)')
    expect(reorderPanes(root, 'a', 0)).toBe(root)
    expect(reorderPanes(root, 'x', 1)).toBe(root)
  })
})

describe('placeTab', () => {
  it('reorders the column’s tabs, keeping which one is shown', () => {
    const root = row(leaf('t'), { ...column('f1', 'f2', 'f3'), shown: 'f2', preview: 'f3' })
    const moved = placeTab(root, 'f3', 0)
    expect(shape(moved)).toBe('row(t,[f3 f1 f2])')
    expect(moved.kind === 'split' && moved.children[1]).toMatchObject({ shown: 'f2', preview: 'f3' })
  })

  it('puts a file pane back into the column, shown', () => {
    const moved = placeTab(row(leaf('t'), column('f1'), file('g')), 'g', 0)
    expect(shape(moved)).toBe('row(t,[g f1])')
    expect(moved.kind === 'split' && moved.children[1]).toMatchObject({ shown: 'g' })
  })

  it('takes no terminal, and needs a column', () => {
    const root = row(leaf('t'), column('f1'))
    expect(placeTab(root, 't', 0)).toBe(root)
    const bare = row(leaf('t'), file('g'))
    expect(placeTab(bare, 'g', 0)).toBe(bare)
  })
})
