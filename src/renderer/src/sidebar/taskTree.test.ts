import { describe, expect, it } from 'vitest'
import { flattenTask, taskForest, taskOrder, taskTally, treeTone } from './taskTree'
import type { DotTone } from './agentRows'

const row = (id: string, parentId?: string, projectId = 'p1') => ({
  id,
  projectId,
  ...(parentId === undefined ? {} : { parentId })
})

/** auth → (migration → (backfill), tests), and a plain worktree after it. */
const WORKTREES = [
  row('auth'),
  row('migration', 'auth'),
  row('lone'),
  row('tests', 'auth'),
  row('backfill', 'migration')
]

const ids = (entries: readonly { worktree: { id: string } }[]): string[] => entries.map((entry) => entry.worktree.id)

describe('building task trees', () => {
  it('puts children under their parent, in the order they were listed', () => {
    const forest = taskForest(WORKTREES)
    expect(ids(forest)).toEqual(['auth', 'lone'])
    expect(ids(forest[0]!.children)).toEqual(['migration', 'tests'])
    expect(ids(forest[0]!.children[0]!.children)).toEqual(['backfill'])
  })

  it('makes a child whose parent is gone, in another project, or in a loop a top-level task', () => {
    const forest = taskForest([
      row('orphan', 'forgotten'),
      row('elsewhere', 'auth', 'p2'),
      row('auth'),
      row('a', 'b'),
      row('b', 'a')
    ])
    expect(ids(forest)).toEqual(['orphan', 'elsewhere', 'auth', 'a', 'b'])
  })

  it('walks parent, then each child with its own children, for every surface that lists them', () => {
    expect(taskOrder(WORKTREES).map((worktree) => worktree.id)).toEqual([
      'auth',
      'migration',
      'backfill',
      'tests',
      'lone'
    ])
  })

  it('flattens one tree to its rows with their depth, leaving out what sits under a collapsed row', () => {
    const [auth] = taskForest(WORKTREES)
    const flat = (collapsed: Record<string, boolean>) =>
      flattenTask(auth!, collapsed).map((entry) => [entry.node.worktree.id, entry.depth])
    expect(flat({})).toEqual([
      ['auth', 0],
      ['migration', 1],
      ['backfill', 2],
      ['tests', 1]
    ])
    expect(flat({ migration: true })).toEqual([
      ['auth', 0],
      ['migration', 1],
      ['tests', 1]
    ])
    expect(flat({ auth: true })).toEqual([['auth', 0]])
  })
})

describe('rolling state up a tree', () => {
  const [auth] = taskForest(WORKTREES)
  const tones = (map: Record<string, DotTone | null>) => (id: string) => map[id] ?? null

  it('gives the most urgent tone underneath, so an asking grandchild outranks a working parent', () => {
    const rolled = treeTone(auth!, tones({ auth: 'working', tests: 'quiet', backfill: 'waiting' }))
    expect(rolled).toEqual({ tone: 'waiting', from: 'backfill' })
  })

  it('keeps the parent’s own tone when nothing underneath is more urgent', () => {
    expect(treeTone(auth!, tones({ auth: 'waiting', tests: 'working' }))).toEqual({ tone: 'waiting', from: 'auth' })
  })

  it('ranks failed over asking, as the board does', () => {
    expect(treeTone(auth!, tones({ tests: 'failed', backfill: 'waiting' }))).toEqual({ tone: 'failed', from: 'tests' })
  })

  it('has no tone where no row has a pane', () => {
    expect(treeTone(auth!, tones({}))).toBeNull()
  })

  it('counts the direct children that are done', () => {
    expect(taskTally(auth!, (worktree) => worktree.id === 'tests')).toEqual({ done: 1, total: 2 })
    // A grandchild's state is its parent's business.
    expect(taskTally(auth!, (worktree) => worktree.id === 'backfill')).toEqual({ done: 0, total: 2 })
  })
})
