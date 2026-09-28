import { describe, expect, it } from 'vitest'
import type { Project, Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import { landingQueue, type QueueInput } from './landingQueue'

const project = (id: string): Project => ({ id, name: id, path: `/repos/${id}`, baseRef: 'origin/main' })

const done = { outcome: 'succeeded' as const, summary: 'Fixed.', paths: [], at: 0 }

const worktree = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'shop',
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

const preview = (worktreeId: string, ahead: number, extra: Partial<WorktreeMergePreview> = {}) => ({
  worktreeId,
  baseRef: 'main',
  state: ahead > 0 ? ('clean' as const) : ('nothingToMerge' as const),
  ahead,
  conflicts: [],
  readAt: 0,
  ...extra
})

function input(): QueueInput {
  const worktrees = [
    worktree('batch1', { report: done }),
    worktree('batch2', { report: done }),
    worktree('idle', {}),
    worktree('parent', { report: done }),
    worktree('kid', { parentId: 'parent', report: done }),
    worktree('broke', { report: { ...done, outcome: 'failed' } }),
    worktree('merged', { report: done }),
    worktree('docs', { projectId: 'site', report: done })
  ]
  return {
    projects: [project('shop'), project('site')],
    worktrees,
    terminals: [],
    statuses: Object.fromEntries(
      worktrees.map((entry) => [entry.id, status(entry.id, entry.id === 'batch2' ? { unstaged: 0 } : {})])
    ),
    mergePreviews: {
      batch1: preview('batch1', 1),
      batch2: preview('batch2', 0),
      idle: preview('idle', 2),
      parent: preview('parent', 1),
      kid: preview('kid', 1),
      broke: preview('broke', 1),
      merged: preview('merged', 0),
      docs: preview('docs', 0)
    },
    landings: { merged: { merged: true } },
    now: 0
  }
}

describe('landingQueue', () => {
  it('lists finished tasks with work, children before their parent, projects in order', () => {
    const base = input()
    const queue = landingQueue({ ...base, statuses: { ...base.statuses, docs: status('docs', { untracked: 2 }) } })
    expect(queue.map((row) => row.worktreeId)).toEqual(['batch1', 'idle', 'kid', 'parent', 'docs'])
  })

  it('leaves out a finished task with nothing to land', () => {
    expect(landingQueue(input()).some((row) => row.worktreeId === 'batch2')).toBe(false)
  })
})
