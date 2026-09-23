// What the sidebar draws and what the next-worktree chord walks must agree; `Sidebar.test.tsx`
// makes the other half of the claim by reading the rendered rows back.

import { describe, expect, it } from 'vitest'
import { worktreeAfter, worktreeOrder, worktreesByProject } from './worktreeOrder'

const PROJECTS = [{ id: 'pager' }, { id: 'relay' }]

/** Interleaved on purpose: this is the shape a runtime answer actually has. */
const WORKTREES = [
  { id: 'w1', projectId: 'pager' },
  { id: 'w2', projectId: 'relay' },
  { id: 'w3', projectId: 'pager' },
  { id: 'w4', projectId: 'relay' }
]

describe('the order the sidebar lays worktrees out in', () => {
  it('is projects in order, and each project’s worktrees in order', () => {
    expect(worktreeOrder(PROJECTS, WORKTREES).map((worktree) => worktree.id)).toEqual(['w1', 'w3', 'w2', 'w4'])
  })

  it('is the flattening of the groups the sidebar renders', () => {
    const groups = worktreesByProject(PROJECTS, WORKTREES)
    expect(groups.map((group) => group.project.id)).toEqual(['pager', 'relay'])
    expect(groups.flatMap((group) => group.rows)).toEqual(worktreeOrder(PROJECTS, WORKTREES))
  })

  // A row the sidebar has nowhere to draw is not somewhere the chord can go.
  it('leaves out a worktree whose project is not on screen', () => {
    const orphaned = [...WORKTREES, { id: 'w5', projectId: 'gone' }]
    expect(worktreeOrder(PROJECTS, orphaned).map((worktree) => worktree.id)).toEqual(['w1', 'w3', 'w2', 'w4'])
  })
})

describe('walking that order', () => {
  const order = worktreeOrder(PROJECTS, WORKTREES)

  it('steps one row at a time, in both directions', () => {
    expect(worktreeAfter(order, 'w1', 1)?.id).toBe('w3')
    // Across the project boundary: the list it walks has no boundary in it.
    expect(worktreeAfter(order, 'w3', 1)?.id).toBe('w2')
    expect(worktreeAfter(order, 'w2', -1)?.id).toBe('w3')
  })

  // A chord that stops at the bottom is a chord you have to know the length of the list to use.
  it('wraps at both ends', () => {
    expect(worktreeAfter(order, 'w4', 1)?.id).toBe('w1')
    expect(worktreeAfter(order, 'w1', -1)?.id).toBe('w4')
  })

  it('undoes itself, from every row', () => {
    for (const worktree of order) {
      expect(worktreeAfter(order, worktreeAfter(order, worktree.id, 1)?.id ?? null, -1)?.id).toBe(worktree.id)
    }
  })

  it('starts at the near end when nothing is open', () => {
    expect(worktreeAfter(order, null, 1)?.id).toBe('w1')
    expect(worktreeAfter(order, null, -1)?.id).toBe('w4')
  })

  it('has nowhere to go in an empty list', () => {
    expect(worktreeAfter([], null, 1)).toBeUndefined()
  })
})
