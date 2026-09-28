// Tab groups: every leaf of the split tree is a group, a lone pane or a set of tabs drawn one at a time.
// Tabs move within and between groups, out to an edge as a group of their own, and a group left empty goes.

import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { fileColumn, fileColumnIn, fileLeaf, withTabs, type FileColumn } from '@shared/filePane'
import {
  addToGroup,
  dropTab,
  focusAfterClose,
  groupOf,
  groupTabIds,
  moveTab,
  moveTabBy,
  paneGroups,
  splitTabOut,
  stripOrder
} from './paneGroups'
import { closePane, leaf, paneStops, shownRoot } from './paneLayout'

const split = (direction: 'row' | 'column', children: PaneNode[], sizes?: number[]): PaneNode => ({
  kind: 'split',
  direction,
  sizes: sizes ?? children.map(() => 1 / children.length),
  children
})
const row = (...children: PaneNode[]): PaneNode => split('row', children)
const col = (...children: PaneNode[]): PaneNode => split('column', children)
const file = (id: string): ReturnType<typeof fileLeaf> => fileLeaf(id, `${id}.ts`)
const tabs = (ids: string[], shown = ids[0]): FileColumn =>
  withTabs(
    { kind: 'split', direction: 'column', sizes: [], children: [], tabs: true },
    ids.map((id) => (id.startsWith('f') ? file(id) : leaf(id))),
    shown
  )

/** The tree as text: `row(a,col(b,c))`, a group as `[a *b]` with its shown tab starred. */
function shape(node: PaneNode | null): string {
  if (node === null) return 'null'
  if (node.kind === 'leaf') return node.terminalId
  if (node.tabs === true) {
    const shown = node.shown ?? (node.children[0]?.kind === 'leaf' ? node.children[0].terminalId : '')
    return `[${node.children.map((child) => (shape(child) === shown ? `*${shown}` : shape(child))).join(' ')}]`
  }
  return `${node.direction === 'row' ? 'row' : 'col'}(${node.children.map(shape).join(',')})`
}

const sizesOf = (node: PaneNode): number[] => (node.kind === 'split' ? node.sizes : [])

describe('groups', () => {
  it('are the leaves and the tab sets, in reading order', () => {
    const root = row(leaf('a'), col(tabs(['b', 'c'], 'c'), leaf('d')))
    expect(paneGroups(root).map(shape)).toEqual(['a', '[b *c]', 'd'])
    expect(groupTabIds(groupOf(root, 'b'))).toEqual(['b', 'c'])
    expect(groupTabIds(groupOf(root, 'a'))).toEqual(['a'])
    expect(groupOf(root, 'nope')).toBeNull()
  })

  it('walk by their shown tab, and number every tab in strip order', () => {
    const root = row(leaf('a'), tabs(['b', 'c'], 'c'), leaf('d'))
    expect(paneStops(root)).toEqual(['a', 'c', 'd'])
    expect(stripOrder(root)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('zoom whole, the other tabs with the one asked for', () => {
    const group = tabs(['b', 'c'], 'c')
    expect(shownRoot(row(leaf('a'), group), 'b')).toBe(group)
    expect(shownRoot(row(leaf('a'), group), 'a')).toEqual(leaf('a'))
  })
})

describe('a new tab', () => {
  it('turns a lone pane into a group and is shown', () => {
    expect(shape(addToGroup(leaf('a'), 'a', leaf('b')))).toBe('[a *b]')
  })

  it('goes after the shown tab of the group holding the pane, the rest of the tree untouched', () => {
    const root = row(leaf('x'), tabs(['a', 'b', 'c'], 'b'))
    const next = addToGroup(root, 'c', leaf('n'))
    expect(shape(next)).toBe('row(x,[a b *n c])')
    expect(sizesOf(next)).toEqual(sizesOf(root))
  })

  it('leaves a tree without the pane as it was', () => {
    const root = row(leaf('a'), leaf('b'))
    expect(addToGroup(root, 'z', leaf('n'))).toBe(root)
  })
})

describe('moving a tab', () => {
  it('reorders within its group', () => {
    const root = tabs(['a', 'b', 'c'], 'a')
    expect(shape(moveTab(root, 'a', 'b', 2))).toBe('[b c *a]')
    expect(shape(moveTab(root, 'c', 'a', 0))).toBe('[*c a b]')
  })

  it('goes into another group at the index, shown there, and its old group shows a neighbour', () => {
    const root = row(tabs(['a', 'b', 'c'], 'b'), tabs(['d', 'e']))
    expect(shape(moveTab(root, 'b', 'd', 1))).toBe('row([a *c],[d *b e])')
  })

  it('collapses the group it leaves empty, its room going to its siblings', () => {
    const root = split('row', [leaf('a'), leaf('b'), leaf('c')], [0.5, 0.25, 0.25])
    const moved = moveTab(root, 'b', 'c', 0)
    expect(shape(moved)).toBe('row(a,[*b c])')
    sizesOf(moved).forEach((size, index) => expect(size).toBeCloseTo([2 / 3, 1 / 3][index]!))
  })

  it('leaves a group of one terminal as the lone pane it is', () => {
    const root = row(tabs(['a', 'b']), leaf('c'))
    expect(shape(moveTab(root, 'b', 'c', 1))).toBe('row(a,[c *b])')
  })

  it('keeps a group of one file a group, as the file column always was', () => {
    const root = row(tabs(['f1', 'f2']), leaf('c'))
    expect(shape(moveTab(root, 'f2', 'c', 1))).toBe('row([*f1],[c *f2])')
  })

  it('does nothing for a tab or a target that is not there', () => {
    const root = row(leaf('a'), leaf('b'))
    expect(moveTab(root, 'z', 'b', 0)).toBe(root)
    expect(moveTab(root, 'a', 'z', 0)).toBe(root)
    expect(moveTab(root, 'a', 'a', 0)).toBe(root)
  })
})

describe('dropping a tab on a pane', () => {
  it('splits it out of its group to that edge, as a group of its own', () => {
    const root = row(tabs(['a', 'b']), leaf('c'))
    expect(shape(dropTab(root, 'b', 'c', 'right'))).toBe('row(a,c,b)')
    expect(shape(dropTab(root, 'b', 'c', 'bottom'))).toBe('row(a,col(c,b))')
    expect(shape(dropTab(root, 'b', 'a', 'left'))).toBe('row(b,a,c)')
  })

  it('moves a lone pane whole', () => {
    expect(shape(dropTab(row(leaf('a'), leaf('b'), leaf('c')), 'a', 'c', 'top'))).toBe('row(b,col(a,c))')
  })

  it('joins the group it is dropped in the middle of, last', () => {
    expect(shape(dropTab(row(leaf('a'), tabs(['b', 'c'])), 'a', 'b', 'center'))).toBe('[b c *a]')
  })

  it('splits its own group when dropped on the group’s edge', () => {
    expect(shape(dropTab(tabs(['a', 'b', 'c'], 'b'), 'b', 'b', 'right'))).toBe('row([a *c],b)')
    expect(shape(dropTab(tabs(['a', 'b']), 'a', 'b', 'bottom'))).toBe('col(b,a)')
  })

  it('does nothing dropped on itself', () => {
    const root = row(leaf('a'), leaf('b'))
    expect(dropTab(root, 'a', 'a', 'right')).toBe(root)
    expect(dropTab(root, 'a', 'a', 'center')).toBe(root)
  })
})

describe('moving a tab by keyboard', () => {
  it('goes to the next or previous group, shown there', () => {
    const root = row(tabs(['a', 'b']), leaf('c'), leaf('d'))
    expect(shape(moveTabBy(root, 'b', 1))).toBe('row(a,[c *b],d)')
    expect(shape(moveTabBy(root, 'c', -1))).toBe('row([a b *c],d)')
  })

  it('splits out on that side past the last group, when its group has company', () => {
    expect(shape(moveTabBy(tabs(['a', 'b']), 'b', 1))).toBe('row(a,b)')
    expect(shape(moveTabBy(tabs(['a', 'b']), 'a', -1))).toBe('row(a,b)')
    const alone = row(leaf('a'), leaf('b'))
    expect(moveTabBy(alone, 'b', 1)).toBe(alone)
  })

  it('splits out right or down', () => {
    expect(shape(splitTabOut(tabs(['a', 'b', 'c'], 'c'), 'c', 'row'))).toBe('row([a *b],c)')
    expect(shape(splitTabOut(tabs(['a', 'b']), 'a', 'column'))).toBe('col(b,a)')
    const alone = leaf('a')
    expect(splitTabOut(alone, 'a', 'row')).toBe(alone)
  })
})

describe('closing', () => {
  it('the last tab of a group collapses it', () => {
    const root = split('row', [leaf('a'), tabs(['b']), leaf('c')], [0.25, 0.5, 0.25])
    expect(shape(closePane(root, 'b'))).toBe('row(a,c)')
  })

  it('a tab of a group leaves a lone terminal as a pane, and shows the tab at its place', () => {
    expect(shape(closePane(row(leaf('x'), tabs(['a', 'b'], 'a')), 'a'))).toBe('row(x,b)')
    expect(shape(closePane(tabs(['a', 'b', 'c'], 'b'), 'b'))).toBe('[a *c]')
  })

  it('moves the focus to the tab its group shows next, else the neighbouring pane', () => {
    expect(focusAfterClose(row(leaf('x'), tabs(['a', 'b', 'c'], 'b')), 'b')).toBe('c')
    expect(focusAfterClose(row(leaf('x'), tabs(['a', 'b'], 'b')), 'b')).toBe('a')
    expect(focusAfterClose(row(leaf('x'), leaf('y')), 'x')).toBe('y')
    expect(focusAfterClose(leaf('x'), 'x')).toBeNull()
  })

  it('moves the focus from a group’s last tab to the tab the neighbouring group shows, never a hidden one', () => {
    expect(focusAfterClose(row(tabs(['a', 'b', 'c'], 'a'), leaf('x')), 'x')).toBe('a')
    expect(focusAfterClose(row(leaf('x'), tabs(['a', 'b', 'c'], 'c')), 'x')).toBe('c')
  })
})

describe('files', () => {
  it('open into the group holding a file, never a group of terminals ahead of it', () => {
    const files = fileColumn(file('f1'))
    const root = row(tabs(['a', 'b']), files)
    expect(fileColumnIn(root)).toBe(files)
    expect(fileColumnIn(row(tabs(['a', 'b']), leaf('c')))).toBeNull()
  })
})
