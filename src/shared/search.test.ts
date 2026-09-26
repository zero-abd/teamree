import { describe, expect, it } from 'vitest'
import { SEARCH_LINE_CHARS, searchLine, searchPattern } from './search'

describe('drawing a search hit', () => {
  it('reads the query literally unless it is a regex, and whole words when asked', () => {
    expect(searchLine(1, 'a.b axb', searchPattern('a.b', {})).ranges).toEqual([[0, 3]])
    expect(searchLine(1, 'a.b axb', searchPattern('a.b', { regex: true })).ranges).toEqual([
      [0, 3],
      [4, 7]
    ])
    expect(searchLine(1, 'limit unlimited', searchPattern('limit', { wholeWord: true })).ranges).toEqual([[0, 5]])
    expect(searchLine(1, 'Limit', searchPattern('limit', { caseSensitive: true })).ranges).toEqual([])
    expect(searchPattern('(', { regex: true })).toBeNull()
  })

  it('clips a long line around its first match and says where the match starts in the whole line', () => {
    const raw = `${'x'.repeat(500)}needle${'y'.repeat(500)}\r`
    const hit = searchLine(7, raw, searchPattern('needle', {}))
    expect(hit.column).toBe(501)
    expect(hit.text.length).toBeLessThanOrEqual(SEARCH_LINE_CHARS + 2)
    expect(hit.text.startsWith('…')).toBe(true)
    const [start, end] = hit.ranges[0] ?? [0, 0]
    expect(hit.text.slice(start, end)).toBe('needle')
  })
})
