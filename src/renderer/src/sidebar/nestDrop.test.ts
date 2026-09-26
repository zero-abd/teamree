import { describe, expect, it } from 'vitest'
import type { NestNode, WorktreeNest } from '@shared/nesting'
import { dropZone, moveUnderChoices, nestAction, nestDropTarget, nestedText, rebaseQuestion, spotKey } from './nestDrop'

const node = (id: string, name: string, parentId?: string, extra: Partial<NestNode> = {}): NestNode => ({
  id,
  name,
  projectId: 'p1',
  state: 'ready',
  ...(parentId === undefined ? {} : { parentId }),
  ...extra
})

/** Rework auth → (Migration → (Backfill)), Docs, and Other in another project. */
const ROWS = [
  node('auth', 'Rework auth'),
  node('mig', 'Migration', 'auth'),
  node('fill', 'Backfill', 'mig'),
  node('docs', 'Docs'),
  node('other', 'Other', undefined, { projectId: 'p2' })
]

const nest = (change: WorktreeNest['change'], worktree: NestNode, inherited?: number): WorktreeNest => ({
  worktree: { branch: worktree.id, path: `/wt/${worktree.id}`, startedFrom: 'main', createdAt: 0, ...worktree },
  change,
  dryRun: false,
  ...(inherited === undefined ? {} : { inherited })
})

describe('dropZone', () => {
  it('is onto the row in its middle and between rows at its edges', () => {
    expect(dropZone(20, 40)).toBe('onto')
    expect(dropZone(11, 40)).toBe('onto')
    expect(dropZone(29, 40)).toBe('onto')
    expect(dropZone(3, 40)).toBe('between')
    expect(dropZone(37, 40)).toBe('between')
  })

  it('takes a row that was never laid out as onto', () => {
    expect(dropZone(0, 0)).toBe('onto')
  })
})

describe('nestDropTarget', () => {
  it('allows a row under another of its project', () => {
    expect(nestDropTarget(ROWS, 'docs', { parentId: 'auth' })).toEqual({ allowed: true, hint: null })
    expect(nestDropTarget(ROWS, 'fill', { projectId: 'p1' })).toEqual({ allowed: true, hint: null })
  })

  it('is no target at all for the row being dragged', () => {
    expect(nestDropTarget(ROWS, 'docs', { parentId: 'docs' })).toBeNull()
  })

  it('refuses with the records’ reason', () => {
    expect(nestDropTarget(ROWS, 'auth', { parentId: 'fill' })).toEqual({
      allowed: false,
      reason: 'Backfill is under Rework auth'
    })
    expect(nestDropTarget(ROWS, 'mig', { parentId: 'auth' })).toEqual({
      allowed: false,
      reason: 'Already under Rework auth'
    })
    expect(nestDropTarget(ROWS, 'docs', { parentId: 'other' })).toEqual({ allowed: false, reason: 'Different project' })
    expect(nestDropTarget(ROWS, 'docs', { projectId: 'p1' })).toEqual({ allowed: false, reason: 'Already top level' })
  })

  it('refuses another project’s header', () => {
    expect(nestDropTarget(ROWS, 'fill', { projectId: 'p2' })).toEqual({ allowed: false, reason: 'Different project' })
  })

  it('refuses with the dry run’s reason once it has answered', () => {
    expect(nestDropTarget(ROWS, 'docs', { parentId: 'auth' }, { reason: 'Uncommitted changes' })).toEqual({
      allowed: false,
      reason: 'Uncommitted changes'
    })
  })

  it('says a rebase is coming, and what an un-nest brings with it', () => {
    expect(nestDropTarget(ROWS, 'docs', { parentId: 'mig' }, { change: 'rebase' })).toEqual({
      allowed: true,
      hint: 'Rebase onto Migration'
    })
    expect(nestDropTarget(ROWS, 'fill', { projectId: 'p1' }, { change: 'unnest', inherited: 3 })).toEqual({
      allowed: true,
      hint: '3 commits from Migration will show'
    })
    expect(nestDropTarget(ROWS, 'mig', { projectId: 'p1' }, { change: 'unnest', inherited: 1 })).toEqual({
      allowed: true,
      hint: '1 commit from Rework auth will show'
    })
    expect(nestDropTarget(ROWS, 'fill', { projectId: 'p1' }, { change: 'unnest', inherited: 0 })).toEqual({
      allowed: true,
      hint: null
    })
  })
})

describe('after the dry run', () => {
  it('asks before a rebase, does nothing for no change, and goes ahead otherwise', () => {
    expect(nestAction(nest('rebase', node('docs', 'Docs', 'mig')))).toBe('confirm')
    expect(nestAction(nest('none', node('mig', 'Migration', 'auth')))).toBe('none')
    expect(nestAction(nest('nest', node('docs', 'Docs', 'auth')))).toBe('apply')
    expect(nestAction(nest('unnest', node('fill', 'Backfill')))).toBe('apply')
  })

  it('asks the rebase question in the owner’s words', () => {
    expect(rebaseQuestion(ROWS, 'docs', 'mig')).toBe('Rebase Docs onto Migration?')
  })
})

describe('nestedText', () => {
  it('says where it went, read against the rows from before the move', () => {
    expect(nestedText(ROWS, nest('nest', node('docs', 'Docs', 'auth')))).toBe('Moved Docs under Rework auth')
    expect(nestedText(ROWS, nest('rebase', node('docs', 'Docs', 'mig')))).toBe('Rebased Docs onto Migration')
    expect(nestedText(ROWS, nest('unnest', node('fill', 'Backfill'), 0))).toBe('Moved Backfill to top level')
    expect(nestedText(ROWS, nest('unnest', node('fill', 'Backfill'), 2))).toBe(
      'Moved Backfill to top level · 2 commits from Migration now show'
    )
  })
})

describe('moveUnderChoices', () => {
  it('lists the rest of its project in tree order, each refused one with its reason', () => {
    expect(moveUnderChoices(ROWS, 'docs')).toEqual([
      { worktree: ROWS[0], depth: 0 },
      { worktree: ROWS[1], depth: 1 },
      { worktree: ROWS[2], depth: 2 }
    ])
    expect(moveUnderChoices(ROWS, 'mig')).toEqual([
      { worktree: ROWS[0], depth: 0, refused: 'Already under Rework auth' },
      { worktree: ROWS[2], depth: 2, refused: 'Backfill is under Migration' },
      { worktree: ROWS[3], depth: 0 }
    ])
  })
})

describe('spotKey', () => {
  it('tells a row from a project header with the same id', () => {
    expect(spotKey({ parentId: 'x' })).not.toBe(spotKey({ projectId: 'x' }))
  })
})
