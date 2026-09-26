import { describe, expect, it } from 'vitest'
import type { WorktreeLanding, WorktreeStatus } from '@shared/entities'
import { landLabel, landOffer } from './landOffer'

const status: WorktreeStatus = {
  worktreeId: 'w1',
  branch: 'rework-auth--tests',
  upstream: 'origin/rework-auth--tests',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0
}

const child: WorktreeLanding = {
  worktreeId: 'w1',
  branch: 'rework-auth--tests',
  base: 'rework-auth',
  host: 'github',
  published: true,
  unmerged: 2,
  merged: false,
  compareUrl: 'https://github.com/a/b/compare/rework-auth...rework-auth--tests',
  readAt: 0,
  parent: { worktreeId: 'w0', name: 'Rework auth' }
}

describe('a child landing', () => {
  it('merges into its parent by name, whatever host the origin is on', () => {
    const offer = landOffer(child, status)
    expect(offer).toEqual({ kind: 'merge', into: 'Rework auth' })
    expect(landLabel(offer as { kind: 'merge'; into: string })).toBe('Merge into Rework auth…')
  })

  it('has nothing to offer once it is in the parent', () => {
    expect(landOffer({ ...child, unmerged: 0, merged: true }, status)).toEqual({ kind: 'merged' })
    expect(landOffer({ ...child, unmerged: 0 }, status)).toBeNull()
  })
})
