// Inside a hunk's runs of changes: which words of a removed and added pair differ, and the patch as
// `git diff -w` would read it. Both work on the parsed patch, so staging still sends git's own hunks.

import type { PatchFile, PatchHunk, PatchLine } from '@shared/patch'

/** Character ranges, `[start, end)`, in ascending order. */
export type Spans = readonly (readonly [number, number])[]

/** Lines longer than this are not compared word by word. */
export const MAX_LINE_LENGTH = 1000

/** Hunks longer than this get no word highlights. */
export const MAX_HUNK_LINES = 4000

/** Added lines after a removed one that may be its partner. */
const PAIR_WINDOW = 8

/** Token grid cells one pair may cost; past it the middle of the pair is marked whole. */
const PAIR_CELLS = 40_000

/** Token grid cells one hunk may spend on pairing before it stops marking. */
const HUNK_CELLS = 4_000_000

/** Below this share of text in common, a pair is two different lines, not an edit. */
const MIN_ALIKE = 0.5

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

/** The changed words of each removed line and the added line it pairs with, by line. */
export function changedSpans(lines: readonly PatchLine[]): Map<PatchLine, Spans> {
  const spans = new Map<PatchLine, Spans>()
  if (lines.length > MAX_HUNK_LINES) return spans
  const budget = { cells: HUNK_CELLS }
  for (const { removed, added } of changeRuns(lines)) {
    let next = 0
    for (const old of removed) {
      if (budget.cells <= 0) return spans
      const end = Math.min(added.length, next + PAIR_WINDOW)
      for (let at = next; at < end; at += 1) {
        const fresh = added[at] as PatchLine
        const found = comparePair(old.text, fresh.text, budget)
        if (found === null) continue
        if (found.old.length > 0) spans.set(old, found.old)
        if (found.new.length > 0) spans.set(fresh, found.new)
        next = at + 1
        break
      }
    }
  }
  return spans
}

/** Each maximal run of removed and added lines, split by kind in order. */
function changeRuns(lines: readonly PatchLine[]): { removed: PatchLine[]; added: PatchLine[] }[] {
  const runs: { removed: PatchLine[]; added: PatchLine[] }[] = []
  let run: { removed: PatchLine[]; added: PatchLine[] } | null = null
  for (const line of lines) {
    if (line.kind === 'context') {
      run = null
      continue
    }
    if (run === null) {
      run = { removed: [], added: [] }
      runs.push(run)
    }
    run[line.kind].push(line)
  }
  return runs.filter((each) => each.removed.length > 0 && each.added.length > 0)
}

/** The differing spans of two lines, or null when they are too long or too unlike to be one edit. */
function comparePair(before: string, after: string, budget: { cells: number }): { old: Spans; new: Spans } | null {
  if (before.length > MAX_LINE_LENGTH || after.length > MAX_LINE_LENGTH) return null
  const a = before.match(TOKEN) ?? []
  const b = after.match(TOKEN) ?? []
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1
  }
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const cells = midA.length * midB.length
  budget.cells -= cells
  const [keepA, keepB] =
    cells <= PAIR_CELLS
      ? commonTokens(midA, midB)
      : [Array.from({ length: midA.length }, () => false), Array.from({ length: midB.length }, () => false)]
  const alike = sharedLength(a, head, tail, midA, keepA)
  if ((2 * alike) / Math.max(1, before.length + after.length) < MIN_ALIKE) return null
  return { old: spansOf(a, head, midA, keepA), new: spansOf(b, head, midB, keepB) }
}

/** Which tokens of each side are in their longest common subsequence. */
function commonTokens(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
  const width = b.length + 1
  const grid = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      grid[i * width + j] =
        a[i] === b[j]
          ? (grid[(i + 1) * width + j + 1] as number) + 1
          : Math.max(grid[(i + 1) * width + j] as number, grid[i * width + j + 1] as number)
    }
  }
  const keepA = Array.from({ length: a.length }, () => false)
  const keepB = Array.from({ length: b.length }, () => false)
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keepA[i] = true
      keepB[j] = true
      i += 1
      j += 1
    } else if ((grid[(i + 1) * width + j] as number) >= (grid[i * width + j + 1] as number)) i += 1
    else j += 1
  }
  return [keepA, keepB]
}

function sharedLength(
  all: readonly string[],
  head: number,
  tail: number,
  mid: readonly string[],
  keep: readonly boolean[]
): number {
  let length = 0
  for (let at = 0; at < head; at += 1) length += (all[at] as string).length
  for (let at = all.length - tail; at < all.length; at += 1) length += (all[at] as string).length
  mid.forEach((token, at) => {
    if (keep[at]) length += token.length
  })
  return length
}

/** Ranges of the tokens not kept, joined across whitespace between them. */
function spansOf(all: readonly string[], head: number, mid: readonly string[], keep: readonly boolean[]): Spans {
  let offset = 0
  for (let at = 0; at < head; at += 1) offset += (all[at] as string).length
  const spans: [number, number][] = []
  let gap: number | null = null
  mid.forEach((token, at) => {
    const start = offset
    offset += token.length
    if (keep[at]) {
      if (!/^\s+$/.test(token)) gap = null
      else gap ??= start
      return
    }
    const last = spans.at(-1)
    if (last !== undefined && (last[1] === start || gap === last[1])) last[1] = offset
    else spans.push([start, offset])
    gap = null
  })
  return spans
}

const SOURCE = new WeakMap<PatchHunk, PatchHunk>()

/** The hunk git wrote that `hunk` was drawn from; itself when it was drawn as written. */
export function sourceHunk(hunk: PatchHunk): PatchHunk {
  return SOURCE.get(hunk) ?? hunk
}

/** The files as `git diff -w` reads them: lines that differ only in whitespace are context, and hunks left unchanged go. */
export function withoutWhitespace(files: readonly PatchFile[]): PatchFile[] {
  return files.map((file) => {
    const hunks = file.hunks.flatMap((hunk) => {
      const shown = hunkWithoutWhitespace(hunk)
      return shown.lines.some((line) => line.kind !== 'context') ? [shown] : []
    })
    return hunks.length === file.hunks.length && hunks.every((hunk, at) => hunk === file.hunks[at])
      ? file
      : { ...file, hunks }
  })
}

function hunkWithoutWhitespace(hunk: PatchHunk): PatchHunk {
  const lines: PatchLine[] = []
  let changed = false
  let at = 0
  while (at < hunk.lines.length) {
    const line = hunk.lines[at] as PatchLine
    if (line.kind === 'context') {
      lines.push(line)
      at += 1
      continue
    }
    const removed: PatchLine[] = []
    const added: PatchLine[] = []
    while (at < hunk.lines.length && hunk.lines[at]?.kind !== 'context') {
      const each = hunk.lines[at] as PatchLine
      ;(each.kind === 'removed' ? removed : added).push(each)
      at += 1
    }
    const merged = mergeSameLines(removed, added)
    if (merged !== null) changed = true
    lines.push(...(merged ?? [...removed, ...added]))
  }
  if (!changed) return hunk
  const shown = { ...hunk, lines }
  SOURCE.set(shown, hunk)
  return shown
}

/** One run with each removed line that matches a later added one but for whitespace drawn as context; null if none do. */
function mergeSameLines(removed: readonly PatchLine[], added: readonly PatchLine[]): PatchLine[] | null {
  if (removed.length === 0 || added.length === 0 || removed.length * added.length > 1_000_000) return null
  const bare = (line: PatchLine): string => line.text.replace(/\s+/g, '')
  const keys = added.map(bare)
  const out: PatchLine[] = []
  let r = 0
  let a = 0
  let any = false
  for (let i = 0; i < removed.length; i += 1) {
    const key = bare(removed[i] as PatchLine)
    let j = a
    while (j < added.length && keys[j] !== key) j += 1
    if (j === added.length) continue
    const old = removed[i] as PatchLine
    const fresh = added[j] as PatchLine
    out.push(...removed.slice(r, i), ...added.slice(a, j))
    out.push({ ...fresh, kind: 'context', oldNumber: old.oldNumber })
    r = i + 1
    a = j + 1
    any = true
  }
  if (!any) return null
  out.push(...removed.slice(r), ...added.slice(a))
  return out
}
