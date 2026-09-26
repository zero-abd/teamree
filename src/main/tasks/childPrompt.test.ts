import { describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import { CHILD_PREFIX_MAX_LINES, childPromptFor } from './childPrompt'

const project: Project = { id: 'p_api', name: 'api', path: '/repos/api', baseRef: 'origin/main' } as Project

function worktree(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id,
    projectId: 'p_api',
    name: id,
    branch: id,
    path: `/repos/api-${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1,
    ...extra
  }
}

function lookup(...worktrees: Worktree[]) {
  return {
    getWorktree: (id: string) => worktrees.find((entry) => entry.id === id),
    getProject: (id: string) => (id === project.id ? project : undefined)
  }
}

describe('childPromptFor', () => {
  it('names the parent task and the branch the child lands in', () => {
    const parent = worktree('rework-auth', { task: 'Rework auth session\nKeep the cookie name.' })
    const prefix = childPromptFor(lookup(parent, worktree('child', { parentId: 'rework-auth' })), 'child')
    expect(prefix).toBe(
      '[teamree] Child task of "Rework auth session" (branch rework-auth). It lands there, not main.\n' +
        'Me: teamree whoami   Commands: teamree guide'
    )
    expect(prefix?.split('\n').length).toBeLessThanOrEqual(CHILD_PREFIX_MAX_LINES)
  })

  it('leaves a top-level task alone', () => {
    expect(childPromptFor(lookup(worktree('top')), 'top')).toBeUndefined()
    expect(childPromptFor(lookup(worktree('orphan', { parentId: 'gone' })), 'orphan')).toBeUndefined()
  })

  it('keeps a long task to one short line', () => {
    const parent = worktree('p', { task: 'x'.repeat(500) })
    const prefix = childPromptFor(lookup(parent, worktree('c', { parentId: 'p' })), 'c') ?? ''
    expect(prefix.split('\n')[0]?.length).toBeLessThan(160)
  })
})
