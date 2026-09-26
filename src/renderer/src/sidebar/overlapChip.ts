// Which files of a worktree another task or a teammate is changing too, and whether a merge would
// stop on them. A hot file (lockfile, package.json) shows only when it would conflict.

import type { WorktreeOverlap } from '@shared/tasks'

export type OverlapKind = 'conflict' | 'claimed' | 'overlap'

export type OverlapEntry = {
  path: string
  with: WorktreeOverlap['with']
  name: string
  kind: OverlapKind
  /** A conflict that rests on work not yet committed. */
  uncommitted?: true
}

export type OverlapChip = {
  tone: 'overlap' | 'conflict'
  /** `auth.ts`, or `3 files`. */
  label: string
  /** Most telling first; the chip's click opens the first. */
  entries: OverlapEntry[]
  title: string
}

const RANK: Record<OverlapKind, number> = { conflict: 0, claimed: 1, overlap: 2 }

export function overlapChip(
  worktreeId: string,
  overlaps: readonly WorktreeOverlap[] | undefined,
  nameOf: (other: WorktreeOverlap['with']) => string
): OverlapChip | null {
  const entries: OverlapEntry[] = []
  for (const overlap of overlaps ?? []) {
    if (overlap.worktreeId !== worktreeId) continue
    const conflicts = new Set(overlap.conflicts)
    const hot = new Set(overlap.hot ?? [])
    const claimed = new Set(overlap.claimed ?? [])
    const uncommitted = new Set(overlap.uncommitted ?? [])
    const name = nameOf(overlap.with)
    for (const path of overlap.paths) {
      if (hot.has(path) && !conflicts.has(path)) continue
      const kind = conflicts.has(path) ? 'conflict' : claimed.has(path) ? 'claimed' : 'overlap'
      entries.push({ path, with: overlap.with, name, kind, ...(uncommitted.has(path) ? { uncommitted: true } : {}) })
    }
  }
  if (entries.length === 0) return null
  entries.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const files = new Set(entries.map((entry) => entry.path))
  const [only] = files
  return {
    tone: entries.some((entry) => entry.kind === 'conflict') ? 'conflict' : 'overlap',
    label: files.size === 1 && only !== undefined ? only.slice(only.lastIndexOf('/') + 1) : `${files.size} files`,
    entries,
    title: entries.map(titleLine).join('\n')
  }
}

function titleLine(entry: OverlapEntry): string {
  const what = 'base' in entry.with ? `would conflict with ${entry.name}` : `${entry.name} · ${entry.kind}`
  return `${entry.path} · ${what}${entry.uncommitted === true ? ' · uncommitted' : ''}`
}

export type OverlapLine = { text: string; conflict: boolean; entry: OverlapEntry }

/** One line per other worktree for the Changes header, conflicts first. */
export function overlapLines(chip: OverlapChip | null): OverlapLine[] {
  const byOther = new Map<string, OverlapEntry[]>()
  for (const entry of chip?.entries ?? []) {
    const other = entry.with
    const key =
      'handle' in other
        ? `${other.handle}\0${other.worktreeId}`
        : 'base' in other
          ? `\0${other.base}`
          : other.worktreeId
    byOther.set(key, [...(byOther.get(key) ?? []), entry])
  }
  return [...byOther.values()].map((entries) => {
    const first = entries[0] as OverlapEntry
    const conflict = first.kind === 'conflict'
    const count = new Set(entries.map((entry) => entry.path)).size
    return {
      text: `${conflict ? 'Conflicts' : 'Overlaps'} with ${first.name}: ${count === 1 ? '1 file' : `${count} files`}`,
      conflict,
      entry: first
    }
  })
}
