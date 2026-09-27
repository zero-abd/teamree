import { describe, expect, it } from 'vitest'
import type { WorktreeChange, WorktreeChanges, WorktreeLog, WorktreeStatus } from '@shared/entities'
import {
  amendBlocker,
  changeTree,
  commitChoices,
  commitLabel,
  commitScope,
  isPartlyStaged,
  nameParts,
  refLine,
  sectionCount,
  sections,
  type TreeRow
} from './sourceControl'

const change = (path: string, overrides: Partial<WorktreeChange> = {}): WorktreeChange => ({
  path,
  kind: 'modified',
  staged: false,
  unstaged: true,
  ...overrides
})

const listed = (changes: WorktreeChange[], total = changes.length): WorktreeChanges => ({
  worktreeId: 'w1',
  changes,
  total,
  limit: 500,
  truncated: total > changes.length,
  readAt: 0
})

const paths = (rows: readonly WorktreeChange[]): string[] => rows.map((row) => row.path)

describe('the sections', () => {
  const staged = change('src/cart/totals.ts', { staged: true, unstaged: false })
  const partly = change('src/cart/tax/rates.ts', { staged: true, unstaged: true })
  const loose = change('README.md')
  const fresh = change('src/new.ts', { kind: 'untracked' })
  const conflicted = change('src/money.ts', { kind: 'conflicted' })

  it('puts what the next commit takes in Staged, the rest in Changes, and conflicts apart', () => {
    const shown = sections(listed([staged, partly, loose, fresh, conflicted]), undefined, ['src/new.ts'])
    expect(paths(shown.staged)).toEqual(['src/cart/totals.ts', 'src/cart/tax/rates.ts', 'src/new.ts'])
    expect(paths(shown.unstaged)).toEqual(['README.md'])
    expect(paths(shown.conflicts)).toEqual(['src/money.ts'])
  })

  // Partly staged: git holds some of it and the rest waits. One row, in Staged, marked as partial.
  it('lists a partly staged file once, in Staged, until it is ticked whole', () => {
    const shown = sections(listed([partly, loose]), undefined, [])
    expect(paths(shown.staged)).toEqual(['src/cart/tax/rates.ts'])
    expect(paths(shown.unstaged)).toEqual(['README.md'])
    expect(isPartlyStaged(partly, new Set())).toBe(true)
    expect(isPartlyStaged(partly, new Set([partly.path]))).toBe(false)
    expect(isPartlyStaged(staged, new Set())).toBe(false)
  })

  it('never lists a file twice: a branch file still uncommitted is only in its uncommitted section', () => {
    const branch = listed([
      change('README.md', { unstaged: false }),
      change('src/api/limits.ts', { unstaged: false }),
      change('docs/tax.md', { kind: 'added', unstaged: false }),
      change('src/cart/totals.ts', { unstaged: false })
    ])
    const shown = sections(listed([staged, loose]), branch, [])
    expect(paths(shown.committed)).toEqual(['src/api/limits.ts', 'docs/tax.md'])
    const everywhere = [...shown.staged, ...shown.unstaged, ...shown.committed].map((row) => row.path)
    expect(new Set(everywhere).size).toBe(everywhere.length)
  })

  it('leaves out of Committed a file an uncommitted rename moved away', () => {
    const renamed = change('src/b.ts', { kind: 'renamed', from: 'src/a.ts', staged: true, unstaged: false })
    const shown = sections(listed([renamed]), listed([change('src/a.ts', { unstaged: false })]), [])
    expect(shown.committed).toEqual([])
  })

  it('counts the rows past the cap in Changes, and in Staged once every listed change is', () => {
    const rows = Array.from({ length: 3 }, (_, index) => change(`src/f${index}.ts`))
    const capped = listed(rows, 2000)
    const idle = sections(capped, undefined, [])
    expect(idle.unlisted).toBe(1997)
    expect(sectionCount(idle, 'unstaged')).toBe(2000)
    expect(sectionCount(idle, 'staged')).toBe(0)

    const all = sections(capped, undefined, paths(rows))
    expect(all.scope).toBe('all')
    expect(sectionCount(all, 'staged')).toBe(2000)
    expect(sectionCount(all, 'unstaged')).toBe(0)
  })

  it('counts the branch files past its cap', () => {
    const shown = sections(listed([]), listed([change('a.ts', { unstaged: false })], 2002), [])
    expect(shown.committed).toHaveLength(1)
    expect(shown.committedUnlisted).toBe(2001)
  })
})

describe('what Commit takes', () => {
  const loose = change('README.md')
  const staged = change('src/done.ts', { staged: true, unstaged: false })

  it('is the ticked paths, else the index, else everything', () => {
    expect(commitScope(['README.md'], [loose, staged])).toBe('ticked')
    expect(commitScope([], [loose, staged])).toBe('staged')
    expect(commitScope([], [loose])).toBe('all')
  })

  it('is all when every row of a cut-off list is ticked', () => {
    expect(commitScope(['README.md'], [loose], true)).toBe('all')
  })

  it('says how many it commits, and whether that is all of them', () => {
    expect(commitLabel(sections(listed([loose, staged]), undefined, []))).toBe('Commit 1')
    expect(commitLabel(sections(listed([loose, change('b.ts')]), undefined, []))).toBe('Commit All 2')
    expect(commitLabel(sections(listed([loose], 2000), undefined, []))).toBe('Commit All 2,000')
    expect(commitLabel(sections(listed([loose, staged]), undefined, ['README.md']))).toBe('Commit 2')
  })
})

describe('the Commit menu', () => {
  const labels = (choices: ReturnType<typeof commitChoices>): string[] => choices.map((choice) => choice.label)

  it('offers push, the land that fits, and amend', () => {
    const merge = { kind: 'merge', into: 'Checkout tax', parent: true, uncommitted: 2 } as const
    expect(labels(commitChoices({ land: merge, remote: true, amend: null }))).toEqual([
      'Commit',
      'Commit & Push',
      'Commit & Merge into Checkout tax…',
      'Amend Last Commit'
    ])
    expect(labels(commitChoices({ land: { kind: 'create-pr', uncommitted: 1 }, remote: true, amend: null }))).toEqual([
      'Commit',
      'Commit & Push',
      'Commit & Create Pull Request…',
      'Amend Last Commit'
    ])
  })

  it('leaves out what cannot happen here, and says why Amend is off', () => {
    const choices = commitChoices({ land: { kind: 'open-pr', number: 3, url: 'u' }, remote: false, amend: 'Pushed' })
    expect(labels(choices)).toEqual(['Commit', 'Amend Last Commit'])
    expect(choices[1]).toMatchObject({ kind: 'amend', disabled: 'Pushed' })
    expect(labels(commitChoices({ land: { kind: 'merged' }, remote: true, amend: null }))).not.toContain(
      expect.stringMatching(/Merge|Pull/)
    )
  })

  it('offers a blocked land greyed, with the reason', () => {
    const choices = commitChoices({
      land: { kind: 'merge', into: 'main', blocked: '1 conflicted' },
      remote: false,
      amend: null
    })
    expect(choices.find((choice) => choice.kind === 'land')).toMatchObject({
      label: 'Commit & Merge into main…',
      disabled: '1 conflicted'
    })
  })
})

describe('amending', () => {
  const status = (overrides: Partial<WorktreeStatus>): WorktreeStatus => ({
    worktreeId: 'w1',
    branch: 'b',
    upstream: 'origin/b',
    ahead: 1,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    readAt: 0,
    ...overrides
  })
  const log = (count: number): WorktreeLog => ({
    worktreeId: 'w1',
    baseRef: 'origin/main',
    commits: Array.from({ length: count }, (_, index) => ({
      sha: `${index}`.repeat(40),
      shortSha: `${index}`.repeat(7),
      author: 'A',
      committedAt: '',
      subject: 's'
    })),
    truncated: false,
    readAt: 0
  })

  it('rewrites only a commit of this branch that no remote has', () => {
    expect(amendBlocker(status({}), log(1))).toBeNull()
    expect(amendBlocker(status({ upstream: null, ahead: 0 }), log(1))).toBeNull()
    expect(amendBlocker(status({ ahead: 0 }), log(1))).toBe('Already pushed')
    expect(amendBlocker(status({}), log(0))).toBe('No commit on this branch')
    expect(amendBlocker(undefined, undefined)).toBe('No commit on this branch')
  })
})

describe('the tree', () => {
  const rows = [
    change('src/cart/totals.ts'),
    change('src/cart/tax/rates.ts'),
    change('src/cart/tax/round.ts'),
    change('README.md'),
    change('docs/guide/intro/start.md'),
    change('src/api/limits.ts')
  ]
  const shape = (tree: TreeRow[]): string[] =>
    tree.map((row) =>
      row.kind === 'folder'
        ? `${'  '.repeat(row.depth)}${row.name}/${row.open ? '' : ' (folded)'}`
        : `${'  '.repeat(row.depth)}${row.change.path.slice(row.change.path.lastIndexOf('/') + 1)}`
    )

  it('groups by folder, folders first, and folds a chain of single folders into one row', () => {
    expect(shape(changeTree(rows, () => false))).toEqual([
      'docs/guide/intro/',
      '  start.md',
      'src/',
      '  api/',
      '    limits.ts',
      '  cart/',
      '    tax/',
      '      rates.ts',
      '      round.ts',
      '    totals.ts',
      'README.md'
    ])
  })

  it('hides what a folded folder holds, and keys the fold by its whole path', () => {
    const tree = changeTree(rows, (path) => path === 'src/cart')
    expect(shape(tree)).toEqual([
      'docs/guide/intro/',
      '  start.md',
      'src/',
      '  api/',
      '    limits.ts',
      '  cart/ (folded)',
      'README.md'
    ])
    expect(tree.find((row) => row.kind === 'folder' && row.name === 'docs/guide/intro')).toMatchObject({
      path: 'docs/guide/intro'
    })
  })

  it('stays quick for the most rows a list holds', () => {
    const many = Array.from({ length: 500 }, (_, index) => change(`pkg${index % 10}/src/deep/file${index}.ts`))
    const started = performance.now()
    const tree = changeTree(many, () => false)
    expect(performance.now() - started).toBeLessThan(200)
    expect(tree.filter((row) => row.kind === 'file')).toHaveLength(500)
  })
})

describe('a long name', () => {
  it('keeps its end, so the ellipsis falls in the middle', () => {
    expect(nameParts('Abdullah_Al_Mahmud_Resume.pdf')).toEqual(['Abdullah_Al_Mahmud_', 'Resume.pdf'])
    expect(nameParts('rates.test.ts')).toEqual(['rates.test.ts', ''])
  })
})

describe('the branch line', () => {
  it('names the branch, the base it is measured against, and the arrows that are not zero', () => {
    expect(refLine('cart-totals', 'origin/main', 1, 2)).toBe('cart-totals → main · ↑1 ↓2')
    expect(refLine('cart-totals', 'checkout-tax', 0, 0)).toBe('cart-totals → checkout-tax')
    expect(refLine('cart-totals', undefined, 3, 0)).toBe('cart-totals · ↑3')
  })
})
