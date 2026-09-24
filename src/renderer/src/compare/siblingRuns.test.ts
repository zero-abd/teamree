import { describe, expect, it } from 'vitest'
import type { Worktree } from '@shared/entities'
import { compareTitle, runName, siblingRuns } from './siblingRuns'

const TASK = 'Add a sub function to src/math.ts'

function worktree(id: string, name: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    projectId: 'p1',
    name,
    branch: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    path: `/wt/${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1,
    task: TASK,
    ...overrides
  }
}

const claude = worktree('w-claude', 'Add a sub function to src/math.ts claude')
const codex = worktree('w-codex', 'Add a sub function to src/math.ts codex')
const claude2 = worktree('w-claude-2', 'Add a sub function to src/math.ts claude 2')

describe('a task’s other runs', () => {
  it('are the checkouts of the same project given the same task, in the order listed', () => {
    const lone = worktree('w-lone', 'Fix the pager', { task: 'Fix the pager' })
    const elsewhere = worktree('w-else', 'Add a sub function to src/math.ts codex', { projectId: 'p2' })
    const untasked = worktree('w-none', 'scratch', { task: undefined })
    const all = [claude, lone, codex, elsewhere, untasked, claude2]
    expect(siblingRuns(claude, all).map((run) => run.id)).toEqual(['w-codex', 'w-claude-2'])
    expect(siblingRuns(lone, all)).toEqual([])
    expect(siblingRuns(untasked, [untasked, worktree('w-none-2', 'other', { task: undefined })])).toEqual([])
  })

  it('leave out a run with no checkout to read', () => {
    const creating = worktree('w-c', 'Add a sub function to src/math.ts codex', { state: 'creating' })
    const missing = worktree('w-m', 'Add a sub function to src/math.ts codex', { missing: true })
    expect(siblingRuns(claude, [claude, creating, missing])).toEqual([])
  })

  it('go by their agent’s name, and a compare by both', () => {
    expect(runName(codex)).toBe('Codex')
    expect(runName(claude2)).toBe('Claude Code 2')
    expect(runName(worktree('w-x', 'perf', { task: 'Speed up' }))).toBe('perf')
    expect(compareTitle(claude, codex)).toBe('Claude Code vs Codex')
  })
})
