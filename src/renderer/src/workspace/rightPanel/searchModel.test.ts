import { describe, expect, it } from 'vitest'
import { groupSearchResults, hitWindow, mergeHits, searchRows, splitAtRanges, stepHit } from './searchModel'

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

describe('a hit’s window', () => {
  const shown = (parts: { text: string; match: boolean }[]): string =>
    parts.map((part) => (part.match ? `[${part.text}]` : part.text)).join('')

  it('keeps a match at the start whole, with the indentation dropped', () => {
    expect(shown(hitWindow('limit(x)', [[0, 5]]))).toBe('[limit](x)')
    expect(shown(hitWindow('\t\t  return limit(x)', [[11, 16]]))).toBe('return [limit](x)')
  })

  it('starts a few columns before a match deep in the line, marked with an ellipsis', () => {
    const text = `${'a'.repeat(80)}limit${'b'.repeat(80)}`
    const parts = hitWindow(text, [[80, 85]], 24, 40)
    expect(shown(parts)).toBe(`…${'a'.repeat(24)}[limit]${'b'.repeat(9)}…`)
  })

  it('shows a match at the end with no trailing ellipsis', () => {
    expect(shown(hitWindow(`${'x'.repeat(100)}limit`, [[100, 105]], 24, 40))).toBe(`…${'x'.repeat(24)}[limit]`)
  })

  it('marks every match in the window and clips one the edge cuts', () => {
    const text = `${'-'.repeat(30)}ab-ab-ab${'-'.repeat(40)}ab`
    const parts = hitWindow(
      text,
      [
        [30, 32],
        [33, 35],
        [36, 38],
        [78, 80]
      ],
      4,
      13
    )
    expect(shown(parts)).toBe('…----[ab]-[ab]-[a]…')
  })

  it('bounds a minified line to the window', () => {
    const text = `${'x;'.repeat(5000)}limit${'y;'.repeat(5000)}`
    const parts = hitWindow(text, [[10000, 10005]])
    const drawn = parts.map((part) => part.text).join('')
    expect(drawn.length).toBeLessThanOrEqual(160)
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(['limit'])
  })

  it('counts wide characters twice and never splits a character', () => {
    expect(shown(hitWindow(`${'日本'.repeat(20)}limit`, [[40, 45]], 24, 40))).toBe(`…${'日本'.repeat(6)}[limit]`)
    const emoji = `${'😀'.repeat(30)}limit`
    const parts = hitWindow(emoji, [[60, 65]], 5, 40)
    expect(shown(parts)).toBe('…😀😀[limit]')
    const accents = `${'e\u0301'.repeat(30)}limit`
    expect(shown(hitWindow(accents, [[60, 65]], 3, 40))).toBe(`…${'e\u0301'.repeat(3)}[limit]`)
  })

  it('draws a tab as a space and a line with no marked match from its start', () => {
    expect(shown(hitWindow('a\tlimit', [[2, 7]]))).toBe('a [limit]')
    expect(shown(hitWindow('    plain line', []))).toBe('plain line')
  })
})
