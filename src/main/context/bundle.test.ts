import { describe, expect, it } from 'vitest'
import type { MemoryNote } from '../../shared/memory'
import { buildBundle, type BundleInput } from './bundle'
import { emptyLedgerWorktree, type LedgerWorktree } from './ledgerStore'
import type { RankedOverlap } from './ranking'

const worktree = (id: string, fields: Partial<LedgerWorktree> = {}): LedgerWorktree => ({
  ...emptyLedgerWorktree(id),
  name: id,
  goal: `goal ${id}`,
  ...fields
})

const note = (id: string, worktreeId: string, text: string, paths?: string[]): MemoryNote => ({
  id,
  worktreeId,
  kind: 'decision',
  text,
  scope: 'private',
  at: 1,
  author: 'me',
  ...(paths ? { paths } : {})
})

const overlap = (worktreeId: string, paths: string[], conflicts: string[] = []): RankedOverlap => ({
  worktreeId,
  paths,
  conflicts,
  claimed: [],
  hot: [],
  score: paths.length + conflicts.length * 3,
  visible: true
})

function input(fields: Partial<BundleInput>): BundleInput {
  const viewer = fields.viewer ?? worktree('me', { touched: ['src/a.ts'] })
  return {
    viewer,
    ancestors: [],
    overlaps: [],
    others: [],
    notes: [],
    budgetTokens: 500,
    revision: 3,
    ...fields
  }
}

describe('the context bundle', () => {
  it('is empty, text and sections alike, when nothing overlaps', () => {
    const parent = worktree('p', { goal: 'Rework the API' })
    const bundle = buildBundle(
      input({ viewer: worktree('me', { parentId: 'p', touched: ['src/a.ts'] }), ancestors: [parent] })
    )
    expect(bundle).toMatchObject({
      worktreeId: 'me',
      revision: 3,
      tokens: 0,
      text: '',
      ancestors: [],
      siblings: [],
      self: { goal: '', decisions: [], questions: [] }
    })
  })

  it('names own goal, parent goal and the overlapping sibling with its paths, conflicts first', () => {
    const sibling = worktree('login', { goal: 'Fix login redirect', touched: ['src/a.ts', 'src/b.ts'] })
    const bundle = buildBundle(
      input({
        viewer: worktree('me', { goal: 'Add rate limits', parentId: 'p', touched: ['src/a.ts', 'src/b.ts'] }),
        ancestors: [worktree('p', { goal: 'Rework the API' })],
        overlaps: [overlap('login', ['src/a.ts', 'src/b.ts'], ['src/a.ts'])],
        others: [sibling]
      })
    )
    expect(bundle.text).toBe(
      [
        'goal: Add rate limits',
        'parent: Rework the API',
        'sibling login: Fix login redirect',
        '  conflict: src/a.ts',
        '  overlap: src/b.ts'
      ].join('\n')
    )
    expect(bundle.self.goal).toBe('Add rate limits')
    expect(bundle.ancestors).toEqual([{ worktreeId: 'p', name: 'p', goal: 'Rework the API' }])
    expect(bundle.siblings[0]).toMatchObject({
      worktreeId: 'login',
      overlap: ['src/a.ts', 'src/b.ts'],
      conflicts: ['src/a.ts']
    })
    expect(bundle.tokens).toBe(Math.ceil(bundle.text.length / 4))
  })

  it('shows a sibling’s decision only when its paths touch mine', () => {
    const viewer = worktree('me', { touched: ['src/a.ts'] })
    const sibling = worktree('s', { touched: ['src/a.ts', 'src/b.ts'] })
    const elsewhere = note('n1', 's', 'Keep b.ts pure', ['src/b.ts'])
    const here = note('n2', 's', 'a.ts exports one limiter', ['src/a.ts'])
    const pathless = note('n3', 's', 'Use postgres')

    const hidden = buildBundle(
      input({ viewer, overlaps: [overlap('s', ['src/a.ts'])], others: [sibling], notes: [elsewhere, pathless] })
    )
    expect(hidden.siblings[0]?.decisions).toEqual([])
    expect(hidden.text).not.toContain('decision')

    const shown = buildBundle(input({ viewer, overlaps: [], others: [sibling], notes: [elsewhere, here] }))
    expect(shown.siblings.map((row) => row.worktreeId)).toEqual(['s'])
    expect(shown.siblings[0]?.decisions.map((row) => row.id)).toEqual(['n2'])
    expect(shown.text).toContain('  decision: a.ts exports one limiter (src/a.ts)')
  })

  it('keeps under the budget, cutting whole siblings last-ranked first and saying how many', () => {
    const others = Array.from({ length: 30 }, (_, index) =>
      worktree(`s${index}`, { goal: `sibling task number ${index} with a longish goal line` })
    )
    const bundle = buildBundle(
      input({
        viewer: worktree('me', { goal: 'mine', touched: ['src/shared.ts'] }),
        overlaps: others.map((row) => overlap(row.id, ['src/shared.ts'])),
        others,
        budgetTokens: 200
      })
    )
    expect(bundle.tokens).toBeLessThanOrEqual(200)
    expect(bundle.siblings[0]?.worktreeId).toBe('s0')
    const dropped = bundle.truncated.find((row) => row.section === 'siblings')?.dropped ?? 0
    expect(bundle.siblings.length + dropped).toBe(30)
    expect(dropped).toBeGreaterThan(0)
  })

  it('answers only the sections asked for', () => {
    const sibling = worktree('s', { touched: ['src/a.ts'] })
    const bundle = buildBundle(
      input({ overlaps: [overlap('s', ['src/a.ts'])], others: [sibling], sections: ['siblings'] })
    )
    expect(bundle.self.goal).toBe('')
    expect(bundle.text.startsWith('sibling s:')).toBe(true)
  })
})
