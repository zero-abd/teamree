import { describe, expect, it } from 'vitest'
import { conflictCount, parseConflicts } from './conflictMarkers'

const MERGED = [
  'export const add = 1',
  '<<<<<<< HEAD',
  'export const sub = 2',
  '=======',
  'export const div = 3',
  '>>>>>>> cart-totals',
  'export const end = 0',
  ''
].join('\n')

describe('parseConflicts', () => {
  it('splits a file into its text and each conflict with both sides and their labels', () => {
    expect(parseConflicts(MERGED)).toEqual([
      { kind: 'text', lines: ['export const add = 1'] },
      {
        kind: 'conflict',
        line: 2,
        ours: ['export const sub = 2'],
        theirs: ['export const div = 3'],
        oursLabel: 'HEAD',
        theirsLabel: 'cart-totals'
      },
      { kind: 'text', lines: ['export const end = 0', ''] }
    ])
    expect(conflictCount(MERGED)).toBe(1)
  })

  it('keeps the base of a diff3 conflict and counts every block', () => {
    const diff3 = [
      '<<<<<<< a',
      'x',
      '||||||| base',
      'o',
      '=======',
      'y',
      '>>>>>>> b',
      'mid',
      '<<<<<<< a',
      '=======',
      'z',
      '>>>>>>> b'
    ].join('\n')
    const parts = parseConflicts(diff3)
    expect(parts[0]).toMatchObject({ kind: 'conflict', ours: ['x'], base: ['o'], theirs: ['y'] })
    expect(parts[2]).toMatchObject({ kind: 'conflict', line: 9, ours: [], theirs: ['z'] })
    expect(conflictCount(diff3)).toBe(2)
  })

  it('reads a file with no markers, or an unclosed one, as text', () => {
    expect(conflictCount('plain\n')).toBe(0)
    expect(parseConflicts('a\n<<<<<<< HEAD\nb')).toEqual([{ kind: 'text', lines: ['a', '<<<<<<< HEAD', 'b'] }])
    // Seven characters and then a space or the end: a longer run is text.
    expect(conflictCount('<<<<<<<< x\n=======\n>>>>>>> y')).toBe(0)
  })
})
