import { describe, expect, it } from 'vitest'
import type { ProjectMemory } from '@shared/ledgerMethods'
import type { MemoryNote } from '@shared/memory'
import { globsMeet, projectContext, worktreeContext } from './contextModel'

function note(id: string, worktreeId: string, extra: Partial<MemoryNote> = {}): MemoryNote {
  return { id, worktreeId, kind: 'decision', text: id, scope: 'private', at: 1, author: 'me', ...extra }
}

const MEMORY: ProjectMemory = {
  projectId: 'p1',
  revision: 3,
  worktrees: [
    { worktreeId: 'auth', claims: ['src/auth/**'], touched: ['src/api/limits.ts', 'src/auth/token.ts'] },
    { worktreeId: 'limits', claims: ['src/api/**', 'docs/limits.md'], touched: ['src/api/limits.ts'] },
    { worktreeId: 'docs', claims: ['README.md'], touched: ['README.md'] }
  ],
  notes: [
    note('tokens-stay-jwt', 'auth', { paths: ['src/auth/token.ts'] }),
    note('keep-v1?', 'auth', { kind: 'question', open: true }),
    note('answered?', 'auth', { kind: 'question', open: false }),
    note('summary', 'auth', { kind: 'summary' }),
    note('limit-per-user', 'limits', { paths: ['src/api/limits.ts'] }),
    note('rename-docs', 'limits', { paths: ['docs/**'] }),
    note('readme-short', 'docs', { paths: ['README.md'] }),
    note('gone-worktree', 'removed', { paths: ['src/api/limits.ts'] })
  ]
}

describe('globsMeet', () => {
  it('meets a path inside a glob, either way round, and a directory claim', () => {
    expect(globsMeet('src/api/limits.ts', 'src/api/**')).toBe(true)
    expect(globsMeet('src/api/**', 'src/api/limits.ts')).toBe(true)
    expect(globsMeet('src/api', 'src/api/limits.ts')).toBe(true)
    expect(globsMeet('src/auth/**', 'src/api/**')).toBe(false)
  })
})

describe('worktreeContext', () => {
  it('has its own claims, decisions and open questions', () => {
    const context = worktreeContext(MEMORY, 'auth')
    expect(context.claims).toEqual(['src/auth/**'])
    expect(context.notes.map((row) => row.id)).toEqual(['tokens-stay-jwt', 'keep-v1?'])
  })

  it('keeps only the siblings whose claims or decisions touch its paths', () => {
    const context = worktreeContext(MEMORY, 'auth')
    expect(context.siblings).toEqual([
      { worktreeId: 'limits', claims: ['src/api/**'], notes: [expect.objectContaining({ id: 'limit-per-user' })] }
    ])
  })

  it('counts its claims as its paths, so a claim alone draws a sibling in', () => {
    const context = worktreeContext(MEMORY, 'docs')
    expect(context.siblings).toEqual([])
    const claiming = worktreeContext(
      {
        ...MEMORY,
        worktrees: MEMORY.worktrees.map((row) => (row.worktreeId === 'docs' ? { ...row, claims: ['docs/**'] } : row))
      },
      'docs'
    )
    expect(claiming.siblings).toEqual([
      {
        worktreeId: 'limits',
        claims: ['docs/limits.md'],
        notes: [expect.objectContaining({ id: 'rename-docs' })]
      }
    ])
  })

  it('is empty before the ledger has been read', () => {
    expect(worktreeContext(undefined, 'auth')).toEqual({ claims: [], notes: [], siblings: [] })
  })
})

describe('projectContext', () => {
  it('lists each live task with claims or notes, and nothing for a removed one', () => {
    expect(
      projectContext(MEMORY).map((row) => [row.worktreeId, row.claims, row.notes.map((entry) => entry.id)])
    ).toEqual([
      ['auth', ['src/auth/**'], ['tokens-stay-jwt', 'keep-v1?']],
      ['limits', ['src/api/**', 'docs/limits.md'], ['limit-per-user', 'rename-docs']],
      ['docs', ['README.md'], ['readme-short']]
    ])
  })

  it('leaves out a task with nothing to say', () => {
    expect(
      projectContext({ ...MEMORY, worktrees: [{ worktreeId: 'x', claims: [], touched: ['a.ts'] }], notes: [] })
    ).toEqual([])
  })
})
