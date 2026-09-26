import { describe, expect, it } from 'vitest'
import { emptyLedgerWorktree, type LedgerWorktree } from './ledgerStore'
import { hotPathTest, rankOverlaps, unrelated } from './ranking'

const worktree = (id: string, fields: Partial<LedgerWorktree> = {}): LedgerWorktree => ({
  ...emptyLedgerWorktree(id),
  name: id,
  goal: `goal ${id}`,
  ...fields
})

const noConflicts = (): string[] => []

describe('overlap ranking', () => {
  it('ranks a real conflict above a plain overlap, and both above a hot file', () => {
    const me = worktree('a', { touched: ['package.json', 'src/api/auth.ts', 'src/app.ts'] })
    const other = worktree('b', { touched: ['package.json', 'src/api/auth.ts', 'src/app.ts'] })
    const [overlap] = rankOverlaps(me, [other], {
      conflicts: () => ['src/api/auth.ts'],
      isHot: hotPathTest([me, other])
    })
    expect(overlap).toMatchObject({
      worktreeId: 'b',
      paths: ['src/api/auth.ts', 'src/app.ts', 'package.json'],
      conflicts: ['src/api/auth.ts'],
      hot: ['package.json']
    })
  })

  it('down-weights hot files until they alone are not an overlap worth showing', () => {
    const me = worktree('a', { touched: ['package.json', 'package-lock.json', 'src/a.ts'] })
    const other = worktree('b', { touched: ['package.json', 'package-lock.json', 'src/b.ts'] })
    const [overlap] = rankOverlaps(me, [other], { conflicts: noConflicts, isHot: hotPathTest([me, other]) })
    expect(overlap?.hot).toEqual(['package-lock.json', 'package.json'])
    expect(overlap?.score).toBeLessThan(1)
    expect(overlap?.visible).toBe(false)
  })

  it('counts a file most live worktrees touch as hot', () => {
    const shared = 'src/index.css'
    const all = ['a', 'b', 'c', 'd'].map((id) => worktree(id, { touched: [shared, `src/${id}.ts`] }))
    expect(hotPathTest(all)(shared)).toBe(true)
    expect(hotPathTest(all.slice(0, 2))(shared)).toBe(false)
  })

  it('reads a path inside the other side’s claim as an overlap, both ways', () => {
    const me = worktree('a', { touched: ['src/api/auth.ts'] })
    const claimer = worktree('b', { claims: ['src/api/**'] })
    const [mine] = rankOverlaps(me, [claimer], { conflicts: noConflicts, isHot: () => false })
    expect(mine).toMatchObject({ worktreeId: 'b', paths: ['src/api/auth.ts'], claimed: ['src/api/auth.ts'] })

    const [theirs] = rankOverlaps(claimer, [me], { conflicts: noConflicts, isHot: () => false })
    expect(theirs).toMatchObject({ worktreeId: 'a', claimed: ['src/api/auth.ts'], visible: true })
  })

  it('leaves out worktrees that share nothing', () => {
    const me = worktree('a', { touched: ['src/a.ts'], claims: ['docs/**'] })
    expect(
      rankOverlaps(me, [worktree('b', { touched: ['src/b.ts'] })], { conflicts: noConflicts, isHot: () => false })
    ).toEqual([])
  })

  it('never pairs a worktree with its ancestors, descendants or fanned-out runs of its task', () => {
    const parent = worktree('p', { goal: 'api' })
    const child = worktree('c', { parentId: 'p' })
    const grandchild = worktree('g', { parentId: 'c' })
    const runA = worktree('r1', { goal: 'same task' })
    const runB = worktree('r2', { goal: 'same task' })
    const cousin = worktree('x', { parentId: 'p', goal: 'other' })
    const byId = new Map([parent, child, grandchild, runA, runB, cousin].map((row) => [row.id, row]))
    expect(unrelated(grandchild, parent, byId)).toBe(false)
    expect(unrelated(parent, grandchild, byId)).toBe(false)
    expect(unrelated(runA, runB, byId)).toBe(false)
    expect(unrelated(grandchild, cousin, byId)).toBe(true)
  })
})
