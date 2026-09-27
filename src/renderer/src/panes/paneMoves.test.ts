// Rearranging the tree: a pane dropped on another pane's edge. A group of tabs always moves as one pane;
// its tabs moving one at a time is `paneGroups.test.ts`.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { fileLeaf, withTabs, type FileColumn } from '@shared/filePane'
import { leaf, movePane, type DropEdge } from './paneLayout'

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

  it('moves the file column as one pane, by any of its tabs', () => {
    const files = column('f1', 'f2')
    const moved = movePane(row(leaf('t'), files), 'f2', 't', 'left')
    expect(shape(moved)).toBe('row([f1 f2],t)')
    expect(moved.kind === 'split' && moved.children[0]).toEqual(files)
  })

  it('leaves the tree as it was for itself, its own column, or an id not in it', () => {
    const root = row(leaf('a'), column('f1', 'f2'))
    expect(movePane(root, 'a', 'a', 'left')).toBe(root)
    expect(movePane(root, 'f1', 'f2', 'right')).toBe(root)
    expect(movePane(root, 'x', 'a', 'right')).toBe(root)
    expect(movePane(root, 'a', 'f1', 'center')).toBe(root)
    expect(movePane(root, 'a', 'x', 'right')).toBe(root)
  })
})
