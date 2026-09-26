import { describe, expect, it } from 'vitest'
import type { WorktreeLanding, WorktreeStatus } from '@shared/entities'
import { headerActions, idleLand, landLabel, landOffer, pushOffer } from './landOffer'

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

const top: WorktreeLanding = {
  worktreeId: 'w1',
  branch: 'fix-typo',
  base: 'main',
  host: null,
  published: false,
  unmerged: 1,
  merged: false,
  readAt: 0
}
const hub: WorktreeLanding = { ...top, host: 'github', published: true, remote: true }
const dirty = { ...status, unstaged: 1, untracked: 1 }

describe('the land offer in every state', () => {
  it('merges a clean branch here, and offers nothing once there is nothing to land', () => {
    expect(landOffer(top, status)).toEqual({ kind: 'merge', into: 'main' })
    expect(landOffer({ ...top, unmerged: 0 }, status)).toBeNull()
  })

  it('stays on a dirty branch as Commit & Merge, counting what it would commit, even before a commit', () => {
    const offer = landOffer({ ...top, unmerged: 0 }, dirty)
    expect(offer).toEqual({ kind: 'merge', into: 'main', uncommitted: 2 })
    expect(landLabel(offer as { kind: 'merge'; into: string })).toBe('Commit & Merge into main…')
    expect(landOffer(child, dirty)).toEqual({ kind: 'merge', into: 'Rework auth', uncommitted: 2 })
  })

  it('is blocked by conflicts, which no commit settles', () => {
    expect(landOffer(top, { ...status, conflicted: 1 })).toEqual({
      kind: 'merge',
      into: 'main',
      blocked: '1 conflicted'
    })
  })

  it('offers one pull request from a dirty, an unpublished or a pushed branch, counting what it commits first', () => {
    expect(landOffer(hub, status)).toEqual({ kind: 'create-pr' })
    expect(landLabel({ kind: 'create-pr' })).toBe('Create Pull Request…')
    const commitFirst = landOffer(hub, dirty)
    expect(commitFirst).toEqual({ kind: 'create-pr', uncommitted: 2 })
    expect(landLabel(commitFirst as { kind: 'create-pr' })).toBe('Commit & Create PR…')
    expect(landOffer({ ...hub, unmerged: 0 }, dirty)).toEqual({ kind: 'create-pr', uncommitted: 2 })
    expect(landOffer({ ...hub, published: false }, { ...status, upstream: null, ahead: 1 })).toEqual({
      kind: 'create-pr'
    })
    expect(landOffer(hub, { ...status, ahead: 2 })).toEqual({ kind: 'create-pr' })
    expect(landOffer({ ...hub, unmerged: 0 }, status)).toBeNull()
  })

  it('blocks the pull request on conflicts', () => {
    expect(landOffer(hub, { ...status, conflicted: 1 })).toEqual({ kind: 'create-pr', blocked: '1 conflicted' })
  })

  it('opens the pull request already made, dirty or not', () => {
    const pullRequest = { number: 7, url: 'https://github.com/a/b/pull/7', state: 'open' as const }
    expect(landOffer({ ...hub, pullRequest }, dirty)).toEqual({ kind: 'open-pr', number: 7, url: pullRequest.url })
  })
})

describe('what the palette lists when there is nothing to land', () => {
  it('is the land the worktree would make, dimmed', () => {
    expect(idleLand({ ...top, unmerged: 0 })).toEqual({ kind: 'merge', into: 'main', blocked: 'nothing to land' })
    expect(idleLand({ ...child, unmerged: 0 })).toEqual({
      kind: 'merge',
      into: 'Rework auth',
      blocked: 'nothing to land'
    })
    expect(idleLand({ ...hub, unmerged: 0 })).toEqual({ kind: 'create-pr', blocked: 'nothing to land' })
    expect(idleLand(undefined)).toBeNull()
  })
})

describe('publishing', () => {
  const unpublished = { ...status, upstream: null, ahead: 1 }

  it('offers Publish for a branch with commits and a remote to send them to', () => {
    expect(pushOffer(unpublished, undefined, true)).toEqual({ kind: 'publish' })
    expect(pushOffer(unpublished, undefined)).toEqual({ kind: 'publish' })
  })

  it('offers nothing in a repository with no remote', () => {
    expect(pushOffer(unpublished, undefined, false)).toBeNull()
  })
})

describe('the changes header', () => {
  const input = { land: null, push: null, updateFrom: null, uncommitted: false, ahead: 0 }

  it('shows the land as the primary when it is next, the rest in the menu', () => {
    const header = headerActions({
      ...input,
      land: { kind: 'merge', into: 'Rework auth' },
      push: { kind: 'publish' },
      updateFrom: 'Parent',
      ahead: 1
    })
    expect(header.shown).toEqual({ kind: 'land', offer: { kind: 'merge', into: 'Rework auth' } })
    expect(header.primary).toBe(true)
    expect(header.more).toEqual([
      { kind: 'push', offer: { kind: 'publish' } },
      { kind: 'update', from: 'Parent' }
    ])
  })

  it('shows the pull request, which pushes first, with Push and Publish in the menu', () => {
    for (const offer of [{ kind: 'push' as const }, { kind: 'publish' as const }]) {
      const header = headerActions({ ...input, land: { kind: 'create-pr' }, push: offer, ahead: 1 })
      expect(header.shown).toEqual({ kind: 'land', offer: { kind: 'create-pr' } })
      expect(header.primary).toBe(true)
      expect(header.more).toEqual([{ kind: 'push', offer }])
    }
  })

  it('shows Push first when an open pull request lacks commits', () => {
    const open = { kind: 'open-pr' as const, number: 7, url: 'https://example.invalid/7' }
    const header = headerActions({ ...input, land: open, push: { kind: 'push' }, ahead: 1 })
    expect(header.shown).toEqual({ kind: 'push', offer: { kind: 'push' } })
    expect(header.more).toEqual([{ kind: 'land', offer: open }])
  })

  it('keeps the land on screen but not primary while there is something to commit', () => {
    const merge = headerActions({ ...input, land: { kind: 'merge', into: 'main', uncommitted: 1 }, uncommitted: true })
    expect(merge.shown).toEqual({ kind: 'land', offer: { kind: 'merge', into: 'main', uncommitted: 1 } })
    expect(merge.primary).toBe(false)
    const pr = headerActions({
      ...input,
      land: { kind: 'create-pr', uncommitted: 1 },
      push: { kind: 'push' },
      uncommitted: true,
      ahead: 1
    })
    expect(pr.shown).toEqual({ kind: 'land', offer: { kind: 'create-pr', uncommitted: 1 } })
    expect(pr.primary).toBe(false)
    expect(pr.more).toEqual([{ kind: 'push', offer: { kind: 'push' } }])
  })

  it('drops the review page when there is a land, and shows Update alone when it is all there is', () => {
    const review = { kind: 'review' as const, url: 'https://example.invalid/r' }
    expect(headerActions({ ...input, land: { kind: 'create-pr' }, push: review }).more).toEqual([])
    const update = headerActions({ ...input, updateFrom: 'main' })
    expect(update).toEqual({ shown: { kind: 'update', from: 'main' }, primary: false, more: [] })
    expect(headerActions({ ...input, land: { kind: 'merged' } }).shown).toBeNull()
  })
})
