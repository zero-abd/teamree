// Find in a diff, over the parsed patch rather than the page, so a folded hunk is searched too.

import type { PatchFile } from '@shared/patch'
import type { PaneSearchOptions } from '../terminal/paneSearchModel'

/** One hit: which half, file, hunk and line of it, and where in the line's text. */
export type DiffMatch = { half: number; file: number; hunk: number; line: number; start: number; end: number }

/** Counting stops here; the bar then reads `10000+`. */
export const DIFF_MATCH_LIMIT = 10_000

const WORD = /\w/

/** Every hit in reading order across the halves; literal, never a regex. */
export function findInPatches(
  halves: readonly (readonly PatchFile[])[],
  query: string,
  options: PaneSearchOptions,
  limit = DIFF_MATCH_LIMIT
): DiffMatch[] {
  const matches: DiffMatch[] = []
  if (query === '') return matches
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'g' : 'gi')
  for (const [half, files] of halves.entries()) {
    for (const [file, patchFile] of files.entries()) {
      for (const [hunk, patchHunk] of patchFile.hunks.entries()) {
        for (const [line, { text }] of patchHunk.lines.entries()) {
          pattern.lastIndex = 0
          for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
            const start = hit.index
            const end = start + hit[0].length
            if (options.wholeWord && (WORD.test(text[start - 1] ?? '') || WORD.test(text[end] ?? ''))) {
              pattern.lastIndex = start + 1
              continue
            }
            matches.push({ half, file, hunk, line, start, end })
            if (matches.length >= limit) return matches
          }
        }
      }
    }
  }
  return matches
}

/** The index a step lands on, wrapping at both ends; -1 with nothing to land on. */
export function stepMatch(current: number, total: number, direction: 'next' | 'previous'): number {
  if (total === 0) return -1
  if (direction === 'next') return (current + 1) % total
  return current <= 0 ? total - 1 : current - 1
}
