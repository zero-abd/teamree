// Which sidebar rows the filter field and chips keep: a match, the tasks above it, and a row just picked.

import { describe, expect, it } from 'vitest'
import type { TaskStage } from '@shared/tasks'
import { filterProject, keepFlat, narrows, rowMatches, type RowFacts, type SidebarView } from './sidebarFilter'

type Row = { id: string; projectId: string; parentId?: string } & RowFacts

const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  projectId: 'p1',
  name: id,
  branch: `${id}-branch`,
  stage: 'stopped',
  changed: false,
  ...overrides
})

const view = (overrides: Partial<SidebarView> = {}): SidebarView => ({
  query: '',
  quick: [],
  compact: false,
  openDone: [],
  ...overrides
})

const shown = (rows: Row[], v: SidebarView, keep: string | null = null, doneOpen = false): string[] =>
  filterProject(rows, (entry) => entry, v, { keep, doneOpen }).rows.map((entry) => entry.id)

describe('the filter field', () => {
  it('matches the name, the branch and the issue number', () => {
    const facts = row('reprice', { name: 'Reprice everything', branch: 'money/reprice', issue: 412 })
    expect(rowMatches(facts, view({ query: 'everything' }))).toBe(true)
    expect(rowMatches(facts, view({ query: 'money/' }))).toBe(true)
    expect(rowMatches(facts, view({ query: '#412' }))).toBe(true)
    expect(rowMatches(facts, view({ query: '412' }))).toBe(true)
    expect(rowMatches(facts, view({ query: '#41 reprice' }))).toBe(true)
    expect(rowMatches(facts, view({ query: 'cart' }))).toBe(false)
    expect(rowMatches(facts, view({ query: '#413' }))).toBe(false)
  })

  it('ignores case, and every word must match somewhere', () => {
    const facts = row('a', { name: 'Checkout tax', branch: 'cart-totals' })
    expect(rowMatches(facts, view({ query: 'TAX Cart' }))).toBe(true)
    expect(rowMatches(facts, view({ query: 'tax ghost' }))).toBe(false)
  })

  it('keeps the parents of a match, and nothing else', () => {
    const rows = [
      row('top'),
      row('mid', { parentId: 'top' }),
      row('leaf', { parentId: 'mid', name: 'the needle' }),
      row('sibling', { parentId: 'top' }),
      row('other')
    ]
    const result = filterProject(rows, (entry) => entry, view({ query: 'needle' }), { keep: null, doneOpen: false })
    expect(result.rows.map((entry) => entry.id)).toEqual(['top', 'mid', 'leaf'])
    expect([...result.context].sort()).toEqual(['mid', 'top'])
  })

  it('always keeps a row just picked, drawn as not matching', () => {
    const result = filterProject([row('a'), row('b')], (entry) => entry, view({ query: 'a-branch' }), {
      keep: 'b',
      doneOpen: false
    })
    expect(result.rows.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect([...result.context]).toEqual(['b'])
  })
})

describe('the chips', () => {
  const stages: [string, TaskStage, boolean][] = [
    ['asking', 'asking', false],
    ['failed', 'failed', false],
    ['working', 'working', false],
    ['changed', 'stopped', true],
    ['done', 'done', false],
    ['landed', 'landed', false],
    ['quiet', 'stopped', false]
  ]
  const rows = stages.map(([id, stage, changed]) => row(id, { stage, changed }))

  it('Needs You keeps asking and failed rows', () => {
    expect(shown(rows, view({ quick: ['needs-you'] }))).toEqual(['asking', 'failed'])
  })

  it('Working keeps working rows', () => {
    expect(shown(rows, view({ quick: ['working'] }))).toEqual(['working'])
  })

  it('Changed keeps rows with uncommitted or unlanded work', () => {
    expect(shown(rows, view({ quick: ['changed'] }))).toEqual(['changed'])
  })

  it('state chips add up rather than narrowing each other', () => {
    expect(shown(rows, view({ quick: ['needs-you', 'working'] }))).toEqual(['asking', 'failed', 'working'])
  })

  it('Mine leaves teammates out and your own rows in', () => {
    const theirs = [row('t1', { theirs: true }), row('t2', { theirs: true })]
    expect(keepFlat(theirs, (entry) => entry, view({ quick: ['mine'] }), false).rows).toEqual([])
    expect(shown(rows, view({ quick: ['mine'] }))).toHaveLength(rows.length)
    expect(keepFlat(theirs, (entry) => entry, view(), false).rows).toHaveLength(2)
  })

  it('Hide Done folds done and landed rows, counted', () => {
    const result = filterProject(rows, (entry) => entry, view({ quick: ['hide-done'] }), {
      keep: null,
      doneOpen: false
    })
    expect(result.rows.map((entry) => entry.id)).toEqual(['asking', 'failed', 'working', 'changed', 'quiet'])
    expect(result.folded).toBe(2)
  })

  it('an unfolded project shows its done rows and keeps the count for folding them again', () => {
    const result = filterProject(rows, (entry) => entry, view({ quick: ['hide-done'] }), {
      keep: null,
      doneOpen: true
    })
    expect(result.rows).toHaveLength(rows.length)
    expect(result.folded).toBe(2)
  })

  it('Hide Done keeps a done parent of a live child, and a row just picked', () => {
    const tree = [row('parent', { stage: 'done' }), row('child', { parentId: 'parent', stage: 'working' })]
    expect(shown(tree, view({ quick: ['hide-done'] }))).toEqual(['parent', 'child'])
    expect(shown([row('d', { stage: 'landed' })], view({ quick: ['hide-done'] }), 'd')).toEqual(['d'])
  })

  it('only the field and the state chips narrow', () => {
    expect(narrows(view())).toBe(false)
    expect(narrows(view({ quick: ['hide-done', 'mine'] }))).toBe(false)
    expect(narrows(view({ quick: ['working'] }))).toBe(true)
    expect(narrows(view({ query: '  x ' }))).toBe(true)
    expect(narrows(view({ query: '   ' }))).toBe(false)
  })
})
