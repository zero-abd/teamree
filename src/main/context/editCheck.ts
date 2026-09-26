// One file an agent is about to edit, against its live siblings: who else
// changes or claims it, and the one to three lines the agent is told.

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { EditCheck, EditOverlapKind } from '../../shared/ledgerMethods'
import { matchesAny, normalizeGlob } from './globs'
import type { LedgerWorktree } from './ledgerStore'

const SIBLINGS_TOLD = 2
const GOAL_CHARS = 80
const RANK: Record<EditOverlapKind, number> = { conflict: 0, claimed: 1, changed: 2 }

/** Repo-relative with `/`, or undefined outside the worktree. A relative path is taken as repo-relative. */
export function repoRelative(root: string, target: string): string | undefined {
  if (!isAbsolute(target)) {
    const path = normalizeGlob(target)
    return path === '' || path.startsWith('../') ? undefined : path
  }
  return inside(root, target) ?? inside(real(root), real(target))
}

function inside(root: string, target: string): string | undefined {
  const path = relative(root, target)
  if (path === '' || path.startsWith('..') || isAbsolute(path)) return undefined
  return path.split(sep).join('/')
}

/** macOS reaches a temp folder through /var and /private/var alike; a new file has only its folder. */
function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(real(parent), basename(path))
  }
}

export type EditOverlapOptions = {
  conflicts: (other: LedgerWorktree) => readonly string[]
  isHot: (path: string) => boolean
}

/** Most telling first. A hot file only changed alongside is left out, as in `rankOverlaps`. */
export function editOverlaps(
  path: string,
  others: readonly LedgerWorktree[],
  options: EditOverlapOptions
): EditCheck['siblings'] {
  const siblings: EditCheck['siblings'] = []
  for (const other of others) {
    const kind: EditOverlapKind | undefined = options.conflicts(other).includes(path)
      ? 'conflict'
      : matchesAny(path, other.claims)
        ? 'claimed'
        : other.touched.includes(path)
          ? 'changed'
          : undefined
    if (kind === undefined || (kind === 'changed' && options.isHot(path))) continue
    siblings.push({ worktreeId: other.id, name: other.name, goal: other.goal, kind })
  }
  return siblings.sort((a, b) => RANK[a.kind] - RANK[b.kind])
}

export function editWarning(path: string, siblings: EditCheck['siblings']): string {
  if (siblings.length === 0) return ''
  const lines = siblings.slice(0, SIBLINGS_TOLD).map((sibling) => {
    const who = sibling.goal === '' ? `${sibling.name} (sibling)` : `${sibling.name} (sibling: "${clip(sibling.goal)}")`
    if (sibling.kind === 'conflict') return `${who} also changes ${path} — would conflict.`
    return sibling.kind === 'claimed' ? `${who} claims ${path}.` : `${who} also changes ${path}.`
  })
  const more = siblings.length - SIBLINGS_TOLD
  if (more > 0) lines[lines.length - 1] += ` (+${more} more)`
  const name = siblings[0]?.name ?? ''
  const to = /^[\w.@/-]+$/.test(name) ? name : JSON.stringify(name)
  lines.push(`Coordinate first: teamree msg ask --to ${to} "<question>", or pick another file.`)
  return lines.join('\n')
}

function clip(goal: string): string {
  return goal.length <= GOAL_CHARS ? goal : `${goal.slice(0, GOAL_CHARS - 1)}…`
}
