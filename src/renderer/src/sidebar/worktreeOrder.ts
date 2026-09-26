// The order the sidebar lays worktrees out in: projects in order, each project's worktrees
// under it, each child task under its parent. Computed once so the list and the "next worktree" chord cannot disagree; generic
// over the row types so the structural slice in `workspaceCommands.ts` can pass what it has.

import { taskOrder } from './taskTree'

export type ProjectLike = { id: string }
export type WorktreeLike = { id: string; projectId: string; parentId?: string }

/** Each project with its own worktrees, in the order the sidebar draws them. */
export function worktreesByProject<P extends ProjectLike, W extends WorktreeLike>(
  projects: readonly P[],
  worktrees: readonly W[]
): { project: P; rows: W[] }[] {
  return projects.map((project) => ({
    project,
    rows: taskOrder(worktrees.filter((worktree) => worktree.projectId === project.id))
  }))
}

/** Every worktree on screen, top to bottom. One whose project is not listed is left out: the sidebar has nowhere to draw it. */
export function worktreeOrder<P extends ProjectLike, W extends WorktreeLike>(
  projects: readonly P[],
  worktrees: readonly W[]
): W[] {
  return worktreesByProject(projects, worktrees).flatMap((group) => group.rows)
}

/**
 * The worktree `step` places along from `currentId`, wrapping at both ends. From nothing open,
 * forwards lands on the first and backwards on the last.
 */
export function worktreeAfter<W extends { id: string }>(
  order: readonly W[],
  currentId: string | null,
  step: 1 | -1
): W | undefined {
  if (order.length === 0) return undefined
  const index = order.findIndex((worktree) => worktree.id === currentId)
  if (index === -1) return step === 1 ? order[0] : order[order.length - 1]
  return order[(index + step + order.length) % order.length]
}
