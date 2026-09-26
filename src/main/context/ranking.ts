// Which other worktrees share this one's files, ranked by how much it matters:
// a merge-tree conflict over a plain overlap, and hot files barely at all.

import { basename } from 'node:path'
import { matchesAny } from './globs'
import type { LedgerWorktree } from './ledgerStore'

/** Files nearly every change touches; an overlap on these alone is noise. */
const HOT_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'go.sum',
  'go.mod',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'CHANGELOG.md',
  'index.ts',
  'index.js',
  'index.tsx'
])

const WEIGHT = { conflict: 4, claimed: 2, overlap: 1, hot: 0.1 } as const

export type RankedOverlap = {
  worktreeId: string
  /** Most telling first. */
  paths: string[]
  conflicts: string[]
  claimed: string[]
  hot: string[]
  score: number
  /** Worth telling an agent about. */
  visible: boolean
}

/** Hot by name, or touched by at least three live worktrees and half of them. */
export function hotPathTest(live: readonly Pick<LedgerWorktree, 'touched'>[]): (path: string) => boolean {
  const counts = new Map<string, number>()
  for (const worktree of live) for (const path of worktree.touched) counts.set(path, (counts.get(path) ?? 0) + 1)
  const floor = Math.max(3, Math.ceil(live.length / 2))
  return (path) => HOT_NAMES.has(basename(path)) || (counts.get(path) ?? 0) >= floor
}

/** Not an ancestor or descendant of the other, and not a fanned-out run of the same task. */
export function unrelated(a: LedgerWorktree, b: LedgerWorktree, byId: ReadonlyMap<string, LedgerWorktree>): boolean {
  if (a.id === b.id) return false
  if (a.goal !== '' && a.goal === b.goal && a.parentId === b.parentId) return false
  return !isAncestor(a.id, b, byId) && !isAncestor(b.id, a, byId)
}

function isAncestor(id: string, of: LedgerWorktree, byId: ReadonlyMap<string, LedgerWorktree>): boolean {
  let cursor = of.parentId
  for (let depth = 0; cursor !== undefined && depth < 32; depth += 1) {
    if (cursor === id) return true
    cursor = byId.get(cursor)?.parentId
  }
  return false
}

export type RankOptions = {
  /** Paths `git merge-tree` says the two would conflict on, as far as is known. */
  conflicts: (otherId: string) => readonly string[]
  isHot: (path: string) => boolean
}

export function rankOverlaps(
  viewer: LedgerWorktree,
  others: readonly LedgerWorktree[],
  options: RankOptions
): RankedOverlap[] {
  const mine = new Set(viewer.touched)
  const ranked: RankedOverlap[] = []
  for (const other of others) {
    const both = other.touched.filter((path) => mine.has(path))
    const claimed = [
      ...viewer.touched.filter((path) => matchesAny(path, other.claims)),
      ...other.touched.filter((path) => matchesAny(path, viewer.claims))
    ]
    const paths = [...new Set([...both, ...claimed])]
    if (paths.length === 0) continue

    const conflicts = new Set(options.conflicts(other.id).filter((path) => mine.has(path)))
    const inClaim = new Set(claimed)
    const weight = (path: string): number =>
      (conflicts.has(path) ? WEIGHT.conflict : inClaim.has(path) ? WEIGHT.claimed : WEIGHT.overlap) *
      (options.isHot(path) ? WEIGHT.hot : 1)
    paths.sort((a, b) => weight(b) - weight(a) || byCodeUnit(a, b))
    const hot = paths.filter(options.isHot)
    ranked.push({
      worktreeId: other.id,
      paths,
      conflicts: paths.filter((path) => conflicts.has(path)),
      claimed: paths.filter((path) => inClaim.has(path)),
      hot,
      score: paths.reduce((sum, path) => sum + weight(path), 0),
      // A real conflict or a claim is evidence enough on any file; a hot file alone is not.
      visible: hot.length < paths.length || conflicts.size > 0 || inClaim.size > 0
    })
  }
  return ranked.sort((a, b) => b.score - a.score || byCodeUnit(a.worktreeId, b.worktreeId))
}

export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
