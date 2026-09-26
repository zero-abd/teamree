// Moving a worktree under another, or back to the top level: what the records alone allow,
// and what `worktree.nest` answers. The git half (tips, rebases, conflicts) is the runtime's.

import type { Worktree } from './entities'
import { MAX_CHILD_DEPTH, MAX_OPEN_CHILDREN } from './tasks'
import { descendantsOf } from './taskTree'

/** Why a nest is refused; the runtime puts it in the error's `data.refusal`. */
export type NestRefusalCode =
  | 'same'
  | 'teammate'
  | 'missing'
  | 'state'
  | 'project'
  | 'unchanged'
  | 'cycle'
  | 'depth'
  | 'children'
  | 'landed'
  | 'needsRebase'
  | 'hasChildren'
  | 'dirty'
  | 'agent'
  | 'published'
  | 'conflicts'

export type NestRefusal = { refusal: NestRefusalCode; reason: string }

/** What `worktree.nest` did, or with `dryRun` would do. `inherited`: an un-nest's commits from the old parent that its diff gains. */
export type WorktreeNest = {
  worktree: Worktree
  change: 'none' | 'nest' | 'rebase' | 'unnest'
  dryRun: boolean
  inherited?: number
}

export type NestNode = Pick<Worktree, 'id' | 'name' | 'projectId' | 'parentId' | 'state'>

/** A teammate's worktree as `teamwork.presence` names it. */
const TEAMMATE_ID = /^peer:/

/**
 * Why `worktreeId` cannot go under `parentId` (null: the top level), or null when the records allow it.
 * `limited` holds agents and scripts to the depth and fan-out limits; git may still refuse.
 */
export function nestRefusal(
  worktrees: readonly NestNode[],
  worktreeId: string,
  parentId: string | null,
  options: { limited?: boolean } = {}
): NestRefusal | null {
  const refuse = (refusal: NestRefusalCode, reason: string): NestRefusal => ({ refusal, reason })
  if (TEAMMATE_ID.test(worktreeId) || (parentId !== null && TEAMMATE_ID.test(parentId))) {
    return refuse('teammate', "Teammate's worktree")
  }
  if (worktreeId === parentId) return refuse('same', 'Same worktree')
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const child = byId.get(worktreeId)
  const parent = parentId === null ? null : byId.get(parentId)
  if (child === undefined || parent === undefined) return refuse('missing', 'Removed')
  for (const worktree of parent === null ? [child] : [child, parent]) {
    if (worktree.state !== 'ready') return refuse('state', `${worktree.name} is ${worktree.state}`)
  }
  if (parent === null) return child.parentId === undefined ? refuse('unchanged', 'Already top level') : null
  if (parent.projectId !== child.projectId) return refuse('project', 'Different project')
  if (child.parentId === parent.id) return refuse('unchanged', `Already under ${parent.name}`)
  const below = descendantsOf(worktrees, child.id)
  if (below.some((worktree) => worktree.id === parent.id))
    return refuse('cycle', `${parent.name} is under ${child.name}`)
  if (options.limited !== true) return null

  const chain = ancestry(byId, parent)
  // The top-level task is depth 0, so the moved worktree sits `chain.length` deep and its subtree below that.
  if (chain.length + subtreeHeight(worktrees, child.id) > MAX_CHILD_DEPTH) {
    return refuse('depth', `${MAX_CHILD_DEPTH} deep under ${(chain[chain.length - 1] as NestNode).name}`)
  }
  const open = worktrees.filter((worktree) => worktree.parentId === parent.id).length
  if (open >= MAX_OPEN_CHILDREN) return refuse('children', `${open} open children under ${parent.name}`)
  return null
}

function ancestry(byId: ReadonlyMap<string, NestNode>, worktree: NestNode): NestNode[] {
  const chain = [worktree]
  let at = worktree
  while (at.parentId !== undefined) {
    const up = byId.get(at.parentId)
    if (up === undefined || chain.includes(up)) break
    chain.push(up)
    at = up
  }
  return chain
}

/** Levels below this worktree: 0 for one with no children. */
function subtreeHeight(worktrees: readonly NestNode[], worktreeId: string, seen = new Set<string>()): number {
  seen.add(worktreeId)
  let height = 0
  for (const worktree of worktrees) {
    if (worktree.parentId !== worktreeId || seen.has(worktree.id)) continue
    height = Math.max(height, 1 + subtreeHeight(worktrees, worktree.id, seen))
  }
  return height
}
