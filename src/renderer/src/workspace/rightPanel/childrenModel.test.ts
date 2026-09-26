import { describe, expect, it } from 'vitest'
import type { Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import { childRows, mergeable, readyToMerge, type ChildrenInput } from './childrenModel'

const worktree = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name: id,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  ...extra
})

const status = (worktreeId: string, extra: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId,
  branch: worktreeId,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...extra
})

const preview = (worktreeId: string, extra: Partial<WorktreeMergePreview> = {}): WorktreeMergePreview => ({
  worktreeId,
  baseRef: 'checkout',
  state: 'clean',
  ahead: 1,
  conflicts: [],
  readAt: 0,
  ...extra
})

const done = { outcome: 'succeeded' as const, summary: 'Cart totals include tax. Tests pass.', paths: [], at: 0 }

function input(overrides: Partial<ChildrenInput> = {}): ChildrenInput {
  return {
    worktrees: [
      worktree('parent'),
      worktree('cart', { parentId: 'parent', name: 'cart totals', report: done }),
      worktree('other'),
      worktree('pay', { parentId: 'parent', name: 'payment', report: done }),
      worktree('grandchild', { parentId: 'cart' }),
      worktree('search', { parentId: 'parent', name: 'search page' }),
      worktree('old', { parentId: 'parent', name: 'old', report: done })
    ],
    terminals: [],
    statuses: {
      cart: status('cart', { behind: 2 }),
      pay: status('pay'),
      search: status('search', { unstaged: 3 }),
      old: status('old')
    },
    mergePreviews: {
      cart: preview('cart', { ahead: 2 }),
      pay: preview('pay', { state: 'conflicts', conflicts: ['money.js'] }),
      search: preview('search', { ahead: 0, state: 'nothingToMerge' }),
      old: preview('old', { ahead: 0, state: 'nothingToMerge' })
    },
    landings: { old: { merged: true, parent: { worktreeId: 'parent', name: 'parent' } } },
    now: 0,
    ...overrides
  }
}

describe('childRows', () => {
  it('lists the direct children in tree order with stage, distance, conflicts and report', () => {
    const rows = childRows('parent', input())
    expect(rows.map((row) => row.worktreeId)).toEqual(['cart', 'pay', 'search', 'old'])
    expect(rows[0]).toMatchObject({
      title: 'cart totals',
      stage: 'done',
      ahead: 2,
      behind: 2,
      conflicts: [],
      report: 'Cart totals include tax. Tests pass.',
      landed: false
    })
    expect(rows[1]).toMatchObject({ stage: 'done', conflicts: ['money.js'] })
    expect(rows[2]).toMatchObject({ stage: 'stopped', uncommitted: 3 })
    expect(rows[3]).toMatchObject({ stage: 'landed', landed: true })
  })

  it('counts an uncommitted conflict with the parent too', () => {
    const rows = childRows(
      'parent',
      input({
        overlaps: [
          {
            worktreeId: 'cart',
            with: { base: 'checkout', worktreeId: 'parent' },
            paths: ['money.js'],
            conflicts: ['money.js'],
            uncommitted: ['money.js']
          }
        ]
      })
    )
    expect(rows[0]?.conflicts).toEqual(['money.js'])
  })

  it('offers only done, clean, unlanded children to Merge All Ready', () => {
    const rows = childRows('parent', input())
    expect(readyToMerge(rows).map((row) => row.worktreeId)).toEqual(['cart'])
    expect(rows.filter(mergeable).map((row) => row.worktreeId)).toEqual(['cart', 'pay', 'search'])
  })

  it('marks a sibling conflict, and leaves the later of the two out of Merge All Ready', () => {
    const between = (worktreeId: string, other: string) => ({
      worktreeId,
      with: { worktreeId: other },
      paths: ['money.js'],
      conflicts: ['money.js']
    })
    const rows = childRows(
      'parent',
      input({
        mergePreviews: { ...input().mergePreviews, pay: preview('pay'), search: preview('search') },
        overlaps: [between('cart', 'pay'), between('pay', 'cart'), between('cart', 'other')]
      })
    )
    expect(rows[0]?.siblingConflicts).toEqual([{ worktreeId: 'pay', title: 'payment', paths: ['money.js'] }])
    expect(rows[1]?.siblingConflicts).toEqual([{ worktreeId: 'cart', title: 'cart totals', paths: ['money.js'] }])
    expect(readyToMerge(rows).map((row) => row.worktreeId)).toEqual(['cart'])
  })

  it('never offers a child whose checkout is missing', () => {
    const rows = childRows('parent', input())
    expect(mergeable({ ...rows[0]!, stage: 'missing' })).toBe(false)
  })

  it('never offers a child whose agent is still at work', () => {
    const rows = childRows(
      'parent',
      input({
        terminals: [
          {
            id: 't1',
            worktreeId: 'cart',
            title: 'claude',
            cwd: '/wt/cart',
            shell: '/bin/zsh',
            agent: 'claude',
            cols: 80,
            rows: 24,
            running: true,
            busy: true,
            lastOutputAt: 0
          }
        ]
      })
    )
    expect(rows[0]?.stage).toBe('working')
    expect(mergeable(rows[0]!)).toBe(false)
  })
})
