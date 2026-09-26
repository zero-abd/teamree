// Dropping a worktree row onto another nests it there; onto its project's header, to the top level.
// What a target says while a row is dragged over it, read from the records and then the dry run.

import { nestRefusal, type NestNode, type WorktreeNest } from '@shared/nesting'
import { flattenTask, taskForest } from './taskTree'

/** Where a row can be dropped: under a worktree, or at the top of a project. */
export type NestSpot = { parentId: string } | { projectId: string }

/** The dry run's answer for one spot, or its refusal's reason. */
export type NestProbe = { reason: string } | Pick<WorktreeNest, 'change' | 'inherited'>

export type DropTarget = { allowed: true; hint: string | null } | { allowed: false; reason: string }

export const spotKey = (spot: NestSpot): string => ('parentId' in spot ? `w:${spot.parentId}` : `p:${spot.projectId}`)

/** A row's middle is onto it, its edges between rows; a row never laid out is all middle. */
export function dropZone(offsetY: number, height: number): 'onto' | 'between' {
  if (height <= 0) return 'onto'
  const edge = height / 4
  return offsetY < edge || offsetY > height - edge ? 'between' : 'onto'
}

const commits = (count: number): string => `${count} commit${count === 1 ? '' : 's'}`

const nameOf = (worktrees: readonly NestNode[], id: string | undefined): string =>
  worktrees.find((worktree) => worktree.id === id)?.name ?? 'its parent'

/** What dropping `worktreeId` on `spot` would do; null when the spot is the row itself. */
export function nestDropTarget(
  worktrees: readonly NestNode[],
  worktreeId: string,
  spot: NestSpot,
  probe?: NestProbe
): DropTarget | null {
  if ('parentId' in spot && spot.parentId === worktreeId) return null
  const moved = worktrees.find((worktree) => worktree.id === worktreeId)
  if ('projectId' in spot && moved !== undefined && moved.projectId !== spot.projectId) {
    return { allowed: false, reason: 'Different project' }
  }
  const parentId = 'parentId' in spot ? spot.parentId : null
  const refusal = nestRefusal(worktrees, worktreeId, parentId)
  if (refusal !== null) return { allowed: false, reason: refusal.reason }
  if (probe === undefined) return { allowed: true, hint: null }
  if ('reason' in probe) return { allowed: false, reason: probe.reason }
  if (probe.change === 'rebase') return { allowed: true, hint: `Rebase onto ${nameOf(worktrees, parentId ?? '')}` }
  if (probe.change === 'unnest' && (probe.inherited ?? 0) > 0) {
    return {
      allowed: true,
      hint: `${commits(probe.inherited ?? 0)} from ${nameOf(worktrees, moved?.parentId)} will show`
    }
  }
  return { allowed: true, hint: null }
}

/** After the dry run: ask first for a rebase, else go ahead unless nothing would change. */
export function nestAction(plan: WorktreeNest): 'none' | 'confirm' | 'apply' {
  if (plan.change === 'none') return 'none'
  return plan.change === 'rebase' ? 'confirm' : 'apply'
}

export function rebaseQuestion(worktrees: readonly NestNode[], worktreeId: string, parentId: string): string {
  return `Rebase ${nameOf(worktrees, worktreeId)} onto ${nameOf(worktrees, parentId)}?`
}

/** What a finished move says; `before` is the rows as they were, for the old parent's name. */
export function nestedText(before: readonly NestNode[], result: WorktreeNest): string {
  const { worktree } = result
  const parent = nameOf(before, worktree.parentId)
  if (result.change === 'rebase') return `Rebased ${worktree.name} onto ${parent}`
  if (worktree.parentId !== undefined) return `Moved ${worktree.name} under ${parent}`
  const inherited = result.inherited ?? 0
  const oldParent = before.find((entry) => entry.id === worktree.id)?.parentId
  const note = inherited > 0 ? ` · ${commits(inherited)} from ${nameOf(before, oldParent)} now show` : ''
  return `Moved ${worktree.name} to top level${note}`
}

export type MoveUnderChoice<W> = { worktree: W; depth: number; refused?: string }

/** The rest of its project in sidebar order, each that cannot take it with the reason why. */
export function moveUnderChoices<W extends NestNode>(
  worktrees: readonly W[],
  worktreeId: string
): MoveUnderChoice<W>[] {
  const moved = worktrees.find((worktree) => worktree.id === worktreeId)
  if (moved === undefined) return []
  const mine = worktrees.filter((worktree) => worktree.projectId === moved.projectId)
  return taskForest(mine)
    .flatMap((node) => flattenTask(node, {}))
    .filter((entry) => entry.node.worktree.id !== worktreeId)
    .map(({ node, depth }) => {
      const refusal = nestRefusal(worktrees, worktreeId, node.worktree.id)
      return { worktree: node.worktree, depth, ...(refusal === null ? {} : { refused: refusal.reason }) }
    })
}
