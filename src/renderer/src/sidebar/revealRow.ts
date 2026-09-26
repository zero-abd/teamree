// Brings a picked worktree's sidebar row into view: its project and parent tasks unfold, and the
// sidebar is asked to scroll to it. Called on every pick, whichever surface made it.

import { useSidebarView } from '../state/sidebarViewStore'
import { useTaskTreeStore } from '../state/taskTreeStore'
import type { TreeWorktree } from './taskTree'

export function revealRow(
  worktreeId: string,
  { worktrees, collapsedProjects, toggleProject }: {
    worktrees: readonly TreeWorktree[]
    collapsedProjects: Readonly<Record<string, boolean>>
    toggleProject: (projectId: string) => void
  }
): void {
  const worktree = worktrees.find((entry) => entry.id === worktreeId)
  if (worktree === undefined) return
  if (collapsedProjects[worktree.projectId]) toggleProject(worktree.projectId)
  const tasks = useTaskTreeStore.getState()
  const seen = new Set([worktree.id])
  for (let at = parentOf(worktree, worktrees); at !== undefined && !seen.has(at.id); at = parentOf(at, worktrees)) {
    seen.add(at.id)
    if (tasks.collapsedTasks[at.id]) tasks.setTaskCollapsed(at.id, false)
  }
  useSidebarView.getState().reveal()
}

function parentOf(worktree: TreeWorktree, worktrees: readonly TreeWorktree[]): TreeWorktree | undefined {
  if (worktree.parentId === undefined) return undefined
  const parent = worktrees.find((entry) => entry.id === worktree.parentId)
  return parent?.projectId === worktree.projectId ? parent : undefined
}
