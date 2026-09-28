// A parent's children as its Changes panel lists them, or the board's finished tasks: stage, distance from
// where they land, what a merge would stop on, and which can land now. Listed order is landing order.

import type { Terminal, Worktree, WorktreeLanding, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import type { TaskStage, WorktreeOverlap } from '@shared/tasks'
import { taskStages } from '../../dashboard/taskRows'
import { worktreeDisplay, worktreeLabel } from '../../sidebar/worktreeDisplay'

export type ChildrenInput = {
  worktrees: readonly Worktree[]
  terminals: readonly Terminal[]
  statuses: Readonly<Record<string, WorktreeStatus>>
  mergePreviews: Readonly<Record<string, Pick<WorktreeMergePreview, 'ahead' | 'state' | 'conflicts'>>>
  landings: Readonly<Record<string, Pick<WorktreeLanding, 'merged' | 'parent'>>>
  overlaps?: readonly WorktreeOverlap[]
  now: number
}

export type ChildRow = {
  worktreeId: string
  title: string
  stage: TaskStage
  /** Commits the parent does not have. */
  ahead: number
  /** Parent commits it does not have. */
  behind: number
  uncommitted: number
  /** Files a merge into the parent would stop on, committed or not. */
  conflicts: string[]
  /** Siblings it conflicts with: whichever of the two lands second stops. */
  siblingConflicts: { worktreeId: string; title: string; paths: string[] }[]
  report?: string
  landed: boolean
}

export function childRows(parentId: string, input: ChildrenInput): ChildRow[] {
  return landingRows(
    input.worktrees.filter((worktree) => worktree.parentId === parentId),
    parentId,
    input
  )
}

/** Sibling tasks against where they land: `ownerId`'s branch, or the base for top-level tasks. */
export function landingRows(
  children: readonly Worktree[],
  ownerId: string | undefined,
  input: ChildrenInput
): ChildRow[] {
  if (children.length === 0) return []
  const stages = taskStages({ ...input, worktrees: children, terminals: [...input.terminals] })
  const titleOf = new Map(children.map((child) => [child.id, worktreeLabel(worktreeDisplay(child))]))
  return children.map((child) => {
    const status = input.statuses[child.id]
    const preview = input.mergePreviews[child.id]
    const conflicts = new Set(preview?.state === 'conflicts' ? preview.conflicts : [])
    const siblingConflicts: ChildRow['siblingConflicts'] = []
    for (const overlap of input.overlaps ?? []) {
      if (overlap.worktreeId !== child.id || overlap.conflicts.length === 0) continue
      const other = overlap.with
      if ('base' in other) {
        if (other.worktreeId === ownerId) for (const path of overlap.conflicts) conflicts.add(path)
      } else if (!('handle' in other)) {
        const title = titleOf.get(other.worktreeId)
        if (title !== undefined)
          siblingConflicts.push({ worktreeId: other.worktreeId, title, paths: overlap.conflicts })
      }
    }
    const stage = stages[child.id] ?? 'stopped'
    return {
      worktreeId: child.id,
      title: worktreeLabel(worktreeDisplay(child)),
      stage,
      ahead: preview?.ahead ?? 0,
      behind: status?.behind ?? 0,
      uncommitted: status === undefined ? 0 : status.staged + status.unstaged + status.untracked + status.conflicted,
      conflicts: [...conflicts].sort(),
      siblingConflicts,
      ...(child.report === undefined ? {} : { report: child.report.summary }),
      landed: stage === 'landed'
    }
  })
}

/** Not landed, with work to land. */
export function unmerged(row: ChildRow): boolean {
  return !row.landed && (row.ahead > 0 || row.uncommitted > 0)
}

/** Unmerged, with no agent at work in it and a checkout to merge from. */
export function mergeable(row: ChildRow): boolean {
  return unmerged(row) && !['working', 'asking', 'failed', 'missing'].includes(row.stage)
}

/** Mergeable and finished: done, or ready. */
export function landable(row: ChildRow): boolean {
  return mergeable(row) && (row.stage === 'done' || row.stage === 'ready')
}

/** A child Merge All Ready leaves out because it clashes with one it lands first. */
export type HeldBack = { worktreeId: string; title: string; clashesWith: string }

/** Mergeable, finished and conflict-free, counting the ones landed before it in this run: what Merge All Ready lands. */
export function readyToMerge(rows: readonly ChildRow[]): ChildRow[] {
  return mergePlan(rows).ready
}

export function heldBack(rows: readonly ChildRow[]): HeldBack[] {
  return mergePlan(rows).held
}

function mergePlan(rows: readonly ChildRow[]): { ready: ChildRow[]; held: HeldBack[] } {
  const ready: ChildRow[] = []
  const held: HeldBack[] = []
  for (const row of rows) {
    if (!landable(row) || row.conflicts.length > 0) continue
    const clash = row.siblingConflicts.find((other) => ready.some((earlier) => earlier.worktreeId === other.worktreeId))
    if (clash === undefined) ready.push(row)
    else held.push({ worktreeId: row.worktreeId, title: row.title, clashesWith: clash.title })
  }
  return { ready, held }
}
