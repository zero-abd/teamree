import { describe, expect, it } from 'vitest'
import { groupSearchResults, mergeHits, searchRows, splitAtRanges, stepHit } from './searchModel'

const hit = (line: number, text = `line ${line}`) => ({ line, column: 1, text, ranges: [] as [number, number][] })

describe('the search model', () => {
  it('keeps a file split across batches as one file', () => {
    const merged = mergeHits(
      [{ worktreeId: 'w1', path: 'a.ts', lines: [hit(1)] }],
      [
        { worktreeId: 'w1', path: 'a.ts', lines: [hit(9)] },
        { worktreeId: 'w2', path: 'a.ts', lines: [hit(2)] }
      ]
    )
    expect(merged.map((file) => [file.worktreeId, file.path, file.lines.map((line) => line.line)])).toEqual([
      ['w1', 'a.ts', [1, 9]],
      ['w2', 'a.ts', [2]]
    ])
  })

  it('groups tasks with the open one first, files by path, and names a task it does not know by id', () => {
    const groups = groupSearchResults(
      [
        { worktreeId: 'w1', path: 'z.ts', lines: [hit(1)] },
        { worktreeId: 'gone', path: 'a.ts', lines: [hit(1)] },
        { worktreeId: 'w2', path: 'b.ts', lines: [hit(3), hit(2)] },
        { worktreeId: 'w1', path: 'a.ts', lines: [hit(1)] }
      ],
      [
        { id: 'w1', name: 'auth' },
        { id: 'w2', name: 'rate' },
        { id: 'w3', name: 'quiet' }
      ],
      'w2'
    )
    expect(groups.map((group) => [group.name, group.matches, group.files.map((file) => file.path)])).toEqual([
      ['rate', 2, ['b.ts']],
      ['auth', 2, ['a.ts', 'z.ts']],
      ['gone', 1, ['a.ts']]
    ])
    expect(groups[0]?.files[0]?.lines.map((line) => line.line)).toEqual([2, 3])
  })

  it('walks hits only, stopping at either end', () => {
    const groups = groupSearchResults([{ worktreeId: 'w1', path: 'a.ts', lines: [hit(1), hit(2)] }], [], null)
    const rows = searchRows(groups, true, new Set())
    expect(rows.map((row) => row.kind)).toEqual(['task', 'file', 'hit', 'hit'])
    const first = stepHit(rows, null, 1)
    expect(first).toBe(rows[2]?.key)
    expect(stepHit(rows, first, -1)).toBe(first)
    expect(stepHit(rows, stepHit(rows, first, 1), 1)).toBe(rows[3]?.key)
    expect(stepHit(rows, null, -1)).toBe(rows[3]?.key)
    expect(searchRows(groups, false, new Set(['w1\u0000a.ts'])).map((row) => row.kind)).toEqual(['file'])
  })

  it('splits text at its matches', () => {
    expect(
      splitAtRanges('a limit b limit', [
        [2, 7],
        [10, 15]
      ])
    ).toEqual([
      { text: 'a ', match: false },
      { text: 'limit', match: true },
      { text: ' b ', match: false },
      { text: 'limit', match: true }
    ])
  })
})
