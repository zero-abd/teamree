// The board's Ready to land: every finished task with work to land, in the order Land All takes them.

import type { Project, Worktree } from '@shared/entities'
import { taskForest, type TaskNode } from '../sidebar/taskTree'
import { worktreesByProject } from '../sidebar/worktreeOrder'
import { landable, landingRows, type ChildRow, type ChildrenInput } from '../workspace/rightPanel/childrenModel'

export type QueueInput = ChildrenInput & { projects: readonly Project[] }

/** Projects in sidebar order; within one, each task after its children, which land in it first. */
export function landingQueue(input: QueueInput): ChildRow[] {
  const siblings = new Map<string | undefined, Worktree[]>()
  for (const worktree of input.worktrees) {
    siblings.set(worktree.parentId, [...(siblings.get(worktree.parentId) ?? []), worktree])
  }
  const rows = new Map<string, ChildRow>()
  for (const [ownerId, group] of siblings) {
    for (const row of landingRows(group, ownerId, input)) rows.set(row.worktreeId, row)
  }
  const walk = (node: TaskNode<Worktree>): ChildRow[] => {
    const row = rows.get(node.worktree.id)
    return [...node.children.flatMap(walk), ...(row === undefined || !landable(row) ? [] : [row])]
  }
  return worktreesByProject(input.projects, input.worktrees).flatMap(({ rows: tasks }) =>
    taskForest(tasks).flatMap(walk)
  )
}
