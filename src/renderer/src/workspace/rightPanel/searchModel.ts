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

export function fileKey(file: { worktreeId: string; path: string }): string {
  return `${file.worktreeId}\0${file.path}`
}
