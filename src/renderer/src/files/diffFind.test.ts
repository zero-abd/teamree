import { describe, expect, it } from 'vitest'
import { parsePatch } from '@shared/patch'
import { findInPatches, stepMatch } from './diffFind'

const PATCH = `diff --git a/src/rank.ts b/src/rank.ts
--- a/src/rank.ts
+++ b/src/rank.ts
@@ -1,2 +1,2 @@
 import { byScore } from './score'
-import { Row } from './row'
+import type { Row } from './row'
@@ -210,2 +210,3 @@ export function rank(rows: Row[]): Row[] {
   const sorted = rows.sort(byScore)
+  const capped = sorted.slice(0, 20)
   return sorted
`

const LOOSE = { caseSensitive: false, wholeWord: false }

describe('finding in a diff', () => {
  it('finds every hit in patch order, across hunks and halves, never in a header', () => {
    const files = parsePatch(PATCH)
    const matches = findInPatches([files, files], 'row', LOOSE)
    expect(matches.map(({ half, hunk, line, start }) => [half, hunk, line, start])).toEqual([
      [0, 0, 1, 9],
      [0, 0, 1, 23],
      [0, 0, 2, 14],
      [0, 0, 2, 28],
      [0, 1, 0, 17],
      [1, 0, 1, 9],
      [1, 0, 1, 23],
      [1, 0, 2, 14],
      [1, 0, 2, 28],
      [1, 1, 0, 17]
    ])
    expect(matches[0]?.end).toBe(12)
  })

  it('matches case and whole words when asked', () => {
    const files = [parsePatch(PATCH)]
    expect(findInPatches(files, 'row', { caseSensitive: true, wholeWord: false })).toHaveLength(3)
    expect(findInPatches(files, 'row', { caseSensitive: false, wholeWord: true })).toHaveLength(4)
    expect(findInPatches(files, 'sorted', { caseSensitive: false, wholeWord: true })).toHaveLength(3)
  })

  it('takes the query literally', () => {
    expect(findInPatches([parsePatch(PATCH)], '(0, 20)', LOOSE)).toHaveLength(1)
    expect(findInPatches([parsePatch(PATCH)], '', LOOSE)).toEqual([])
  })

  it('stops counting at the limit', () => {
    expect(findInPatches([parsePatch(PATCH)], 'o', LOOSE, 4)).toHaveLength(4)
  })

  it('steps round the ends', () => {
    expect(stepMatch(2, 3, 'next')).toBe(0)
    expect(stepMatch(0, 3, 'previous')).toBe(2)
    expect(stepMatch(-1, 3, 'previous')).toBe(2)
    expect(stepMatch(0, 0, 'next')).toBe(-1)
  })
})
