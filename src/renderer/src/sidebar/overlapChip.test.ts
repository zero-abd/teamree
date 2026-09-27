import { describe, expect, it } from 'vitest'
import type { WorktreeOverlap } from '@shared/tasks'
import { overlapChip, overlapLines } from './overlapChip'
import { overlapNamer } from './useOverlapChip'

const names: Record<string, string> = { b: 'Fix login redirect', c: 'Add rate limits', 'peer:ana:w9': 'Tidy auth' }
const nameOf = (other: WorktreeOverlap['with']): string =>
  'base' in other
    ? other.base
    : 'handle' in other
      ? `${other.handle} · ${names[other.worktreeId]}`
      : (names[other.worktreeId] ?? other.worktreeId)

const overlap = (overrides: Partial<WorktreeOverlap> & Pick<WorktreeOverlap, 'with' | 'paths'>): WorktreeOverlap => ({
  worktreeId: 'a',
  conflicts: [],
  ...overrides
})

describe('the overlap chip on a row', () => {
  it('is absent when nothing of this worktree overlaps', () => {
    expect(overlapChip('a', undefined, nameOf)).toBeNull()
    expect(overlapChip('a', [], nameOf)).toBeNull()
    expect(
      overlapChip('a', [overlap({ worktreeId: 'b', with: { worktreeId: 'a' }, paths: ['x.ts'] })], nameOf)
    ).toBeNull()
  })

  it('names the one file an overlap shares, in the overlap tone', () => {
    const chip = overlapChip('a', [overlap({ with: { worktreeId: 'b' }, paths: ['src/api/auth.ts'] })], nameOf)
    expect(chip).toMatchObject({ tone: 'overlap', label: 'auth.ts' })
    expect(chip?.entries).toEqual([
      { path: 'src/api/auth.ts', with: { worktreeId: 'b' }, name: 'Fix login redirect', kind: 'overlap' }
    ])
  })

  it('counts files across every other worktree, and turns red when merge-tree says one conflicts', () => {
    const chip = overlapChip(
      'a',
      [
        overlap({ with: { worktreeId: 'b' }, paths: ['src/a.ts', 'src/b.ts'] }),
        overlap({ with: { worktreeId: 'c' }, paths: ['src/b.ts', 'src/c.ts'], conflicts: ['src/c.ts'] })
      ],
      nameOf
    )
    expect(chip).toMatchObject({ tone: 'conflict', label: '3 files' })
    expect(chip?.entries[0]).toMatchObject({ path: 'src/c.ts', with: { worktreeId: 'c' }, kind: 'conflict' })
  })

  it('never shows for hot files alone, and leaves them out beside real ones', () => {
    const hotOnly = overlap({ with: { worktreeId: 'b' }, paths: ['package.json'], hot: ['package.json'] })
    expect(overlapChip('a', [hotOnly], nameOf)).toBeNull()
    const mixed = overlap({
      with: { worktreeId: 'c' },
      paths: ['src/x.ts', 'package-lock.json'],
      hot: ['package-lock.json']
    })
    expect(overlapChip('a', [hotOnly, mixed], nameOf)?.entries.map((entry) => entry.path)).toEqual(['src/x.ts'])
  })

  it('keeps a hot file that would conflict', () => {
    const chip = overlapChip(
      'a',
      [
        overlap({
          with: { worktreeId: 'b' },
          paths: ['package.json'],
          hot: ['package.json'],
          conflicts: ['package.json']
        })
      ],
      nameOf
    )
    expect(chip).toMatchObject({ tone: 'conflict', label: 'package.json' })
  })

  it('names a teammate’s worktree by handle and task', () => {
    const chip = overlapChip(
      'a',
      [overlap({ with: { handle: 'ana', worktreeId: 'peer:ana:w9' }, paths: ['src/api/auth.ts'] })],
      nameOf
    )
    expect(chip).toMatchObject({ tone: 'overlap', label: 'auth.ts' })
    expect(chip?.entries[0]?.name).toBe('ana · Tidy auth')
  })

  it('lists each file, the other task and conflict or overlap on hover', () => {
    const chip = overlapChip(
      'a',
      [
        overlap({
          with: { worktreeId: 'b' },
          paths: ['src/a.ts', 'src/z.ts'],
          conflicts: ['src/z.ts'],
          claimed: ['src/a.ts']
        }),
        overlap({ with: { handle: 'ana', worktreeId: 'peer:ana:w9' }, paths: ['src/a.ts'] })
      ],
      nameOf
    )
    expect(chip?.title).toBe(
      [
        'src/z.ts · Fix login redirect · conflict',
        'src/a.ts · Fix login redirect · claimed',
        'src/a.ts · ana · Tidy auth · overlap'
      ].join('\n')
    )
  })
})

describe('conflicts before a commit, and with the base', () => {
  it('turns red for a conflict that rests on uncommitted work, and says so on hover', () => {
    const chip = overlapChip(
      'a',
      [
        overlap({
          with: { worktreeId: 'b' },
          paths: ['src/money.js'],
          conflicts: ['src/money.js'],
          uncommitted: ['src/money.js']
        })
      ],
      nameOf
    )
    expect(chip).toMatchObject({ tone: 'conflict', label: 'money.js' })
    expect(chip?.title).toBe('src/money.js · Fix login redirect · conflict · uncommitted')
  })

  it('keeps warning against the base once the sibling landed there', () => {
    const chip = overlapChip(
      'a',
      [
        overlap({
          with: { base: 'main' },
          paths: ['src/money.js'],
          conflicts: ['src/money.js'],
          uncommitted: ['src/money.js']
        })
      ],
      nameOf
    )
    expect(chip).toMatchObject({ tone: 'conflict', label: 'money.js' })
    expect(chip?.title).toBe('src/money.js · would conflict with main · uncommitted')
    expect(overlapLines(chip).map((line) => line.text)).toEqual(['Conflicts with main: 1 file'])
  })
})

describe('the overlap lines in the Changes header', () => {
  it('says one line per other task, conflicts first, with its file count', () => {
    const chip = overlapChip(
      'a',
      [
        overlap({ with: { worktreeId: 'b' }, paths: ['src/a.ts', 'src/b.ts'] }),
        overlap({ with: { worktreeId: 'c' }, paths: ['src/c.ts'], conflicts: ['src/c.ts'] })
      ],
      nameOf
    )
    expect(overlapLines(chip).map((line) => line.text)).toEqual([
      'Conflicts with Add rate limits: 1 file',
      'Overlaps with Fix login redirect: 2 files'
    ])
    expect(overlapLines(chip)[1]?.entry).toMatchObject({ path: 'src/a.ts', with: { worktreeId: 'b' } })
    expect(overlapLines(null)).toEqual([])
  })
})

describe('whom an overlap is with', () => {
  it('names a teammate’s worktree as they do, not by its prompt', () => {
    const theirs = {
      id: 'peer:ana:w9',
      handle: 'ana',
      publicKey: 'k',
      name: 'mate checkout',
      branch: 'mate-checkout',
      task: 'Rework the checkout flow',
      state: 'ready' as const,
      heardAt: 0,
      live: true,
      panes: []
    }
    expect(overlapNamer([], [theirs])({ handle: 'ana', worktreeId: 'peer:ana:w9' })).toBe('ana · mate checkout')
  })
})
