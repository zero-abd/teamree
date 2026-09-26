// What the Search tab draws: streamed batches merged, grouped by task then file,
// and flattened into the rows the arrow keys walk.

import type { SearchFileHits, SearchLine } from '@shared/search'

export type SearchFileGroup = { worktreeId: string; path: string; lines: SearchLine[] }

export type SearchTaskGroup = { worktreeId: string; name: string; files: SearchFileGroup[]; matches: number }

export type SearchRow =
  | { kind: 'task'; key: string; group: SearchTaskGroup }
  | { kind: 'file'; key: string; file: SearchFileGroup; collapsed: boolean }
  | { kind: 'hit'; key: string; file: SearchFileGroup; hit: SearchLine }

/** A batch folded into what arrived before it; a file split across batches stays one file. */
export function mergeHits(current: readonly SearchFileHits[], batch: readonly SearchFileHits[]): SearchFileHits[] {
  const merged = [...current]
  const at = new Map(merged.map((file, index) => [fileKey(file), index]))
  for (const file of batch) {
    const index = at.get(fileKey(file))
    if (index === undefined) {
      at.set(fileKey(file), merged.length)
      merged.push(file)
      continue
    }
    const before = merged[index] as SearchFileHits
    merged[index] = { ...before, lines: [...before.lines, ...file.lines] }
  }
  return merged
}

/** By task (the open one first, then as listed), then by path; a task with no hits is left out. */
export function groupSearchResults(
  files: readonly SearchFileHits[],
  worktrees: readonly { id: string; name: string }[],
  activeId: string | null
): SearchTaskGroup[] {
  const byTask = new Map<string, SearchFileGroup[]>()
  for (const file of files) {
    const list = byTask.get(file.worktreeId) ?? []
    list.push({ ...file, lines: [...file.lines].sort((a, b) => a.line - b.line) })
    byTask.set(file.worktreeId, list)
  }
  const order = [...worktrees].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
  const known = new Set(order.map((worktree) => worktree.id))
  const unknown = [...byTask.keys()].filter((id) => !known.has(id)).map((id) => ({ id, name: id }))
  return [...order, ...unknown].flatMap((worktree) => {
    const list = byTask.get(worktree.id)
    if (!list) return []
    list.sort((a, b) => a.path.localeCompare(b.path))
    return [
      {
        worktreeId: worktree.id,
        name: worktree.name,
        files: list,
        matches: list.reduce((sum, file) => sum + file.lines.length, 0)
      }
    ]
  })
}

/** Task headers only when more than one task could answer; hits of a collapsed file are left out. */
export function searchRows(
  groups: readonly SearchTaskGroup[],
  withTasks: boolean,
  collapsed: ReadonlySet<string>
): SearchRow[] {
  const rows: SearchRow[] = []
  for (const group of groups) {
    if (withTasks) rows.push({ kind: 'task', key: `t:${group.worktreeId}`, group })
    for (const file of group.files) {
      const key = fileKey(file)
      const folded = collapsed.has(key)
      rows.push({ kind: 'file', key: `f:${key}`, file, collapsed: folded })
      if (folded) continue
      for (const hit of file.lines) rows.push({ kind: 'hit', key: `h:${key}\0${hit.line}`, file, hit })
    }
  }
  return rows
}

/** The hit `step` away from `current` among the rows, clamped at the ends; the first when none is chosen. */
export function stepHit(rows: readonly SearchRow[], current: string | null, step: 1 | -1): string | null {
  const hits = rows.filter((row) => row.kind === 'hit').map((row) => row.key)
  if (hits.length === 0) return null
  const at = current === null ? -1 : hits.indexOf(current)
  if (at === -1) return step === 1 ? (hits[0] ?? null) : (hits.at(-1) ?? null)
  return hits[Math.min(Math.max(at + step, 0), hits.length - 1)] ?? null
}

/** The text split at its match ranges, for drawing the matches marked. */
export function splitAtRanges(text: string, ranges: readonly [number, number][]): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start < at) continue
    if (start > at) parts.push({ text: text.slice(at, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts
}

/** Columns of context drawn before a line's first match. */
export const HIT_LEAD_COLUMNS = 24

/** Most columns a hit draws, ellipses included; the panel's edge usually clips sooner. */
export const HIT_WINDOW_COLUMNS = 160

/** The line cut to a window that starts just before its first match, split for marking. */
export function hitWindow(
  text: string,
  ranges: readonly [number, number][],
  lead = HIT_LEAD_COLUMNS,
  width = HIT_WINDOW_COLUMNS
): { text: string; match: boolean }[] {
  const sorted = ranges.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0])
  const indent = text.length - text.replace(/^[ \t]+/, '').length
  const first = Math.min(sorted[0]?.[0] ?? indent, text.length)
  const base = Math.min(first, indent)

  const clusters: { at: number; end: number; columns: number }[] = []
  for (let at = base, past = 0; at < text.length && past <= width; ) {
    const [end, columns] = nextCluster(text, at)
    clusters.push({ at, end, columns })
    if (at >= first) past += columns
    at = end
  }
  let from = clusters.findIndex((cluster) => cluster.end > first)
  if (from === -1) from = clusters.length
  for (let used = 0; from > 0; from -= 1) {
    used += clusters[from - 1]?.columns ?? 0
    if (used > lead) break
  }
  const start = clusters[from]?.at ?? text.length
  const head = start > base ? '…' : ''

  const fill = (room: number): number => {
    let to = from
    for (; to < clusters.length && (clusters[to]?.columns ?? 0) <= room; to += 1) room -= clusters[to]?.columns ?? 0
    return to
  }
  let to = fill(width - head.length)
  if (to < clusters.length || (clusters.at(-1)?.end ?? start) < text.length) to = fill(width - head.length - 1)
  const end = clusters[to]?.at ?? clusters.at(-1)?.end ?? start
  const tail = end < text.length ? '…' : ''

  const kept = sorted.flatMap(([a, b]): [number, number][] =>
    Math.min(b, end) > Math.max(a, start) ? [[Math.max(a, start) - start, Math.min(b, end) - start]] : []
  )
  const parts = splitAtRanges(text.slice(start, end).replace(/\t/g, ' '), kept)
  if (head !== '') parts.unshift({ text: head, match: false })
  if (tail !== '') parts.push({ text: tail, match: false })
  return parts
}

// One user-perceived character from `at`: a code point plus the marks and joined code points after it.
function nextCluster(text: string, at: number): [end: number, columns: number] {
  const code = text.codePointAt(at) ?? 0
  let end = at + (code > 0xffff ? 2 : 1)
  while (end < text.length) {
    const next = text.codePointAt(end) ?? 0
    const joined = next === 0x200d
    if (!joined && (next < 0x300 || !ZERO_WIDTH.test(String.fromCodePoint(next)))) break
    end += next > 0xffff ? 2 : 1
    if (joined && end < text.length) end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1
  }
  return [end, columnsOf(code)]
}

const ZERO_WIDTH = /^[\p{M}\p{Cf}]$/u

function columnsOf(code: number): number {
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return wide ? 2 : 1
}

export function fileKey(file: { worktreeId: string; path: string }): string {
  return `${file.worktreeId}\0${file.path}`
}
