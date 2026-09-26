// The few lines a child task's agent reads before its task: where the work
// lands, and how to ask teamree the rest. A top-level task's prompt is left as typed.

import type { Project, Worktree } from '../../shared/entities'

/** Most lines the prefix may take. */
export const CHILD_PREFIX_MAX_LINES = 5

const MAX_TASK_CHARS = 80

export type TaskLookup = {
  getWorktree(worktreeId: string): Worktree | undefined
  getProject(projectId: string): Project | undefined
}

/** The prefix for a pane opened in `worktreeId`, or undefined when it is not a child task. */
export function childPromptFor(store: TaskLookup, worktreeId: string): string | undefined {
  const parentId = store.getWorktree(worktreeId)?.parentId
  const parent = parentId === undefined ? undefined : store.getWorktree(parentId)
  if (parent === undefined) return undefined
  const base = store.getProject(parent.projectId)?.baseRef.replace(/^origin\//, '')
  const task = parent.task?.split('\n')[0]?.trim() || parent.name
  const title = task.length > MAX_TASK_CHARS ? `${task.slice(0, MAX_TASK_CHARS - 1)}…` : task
  return [
    `[teamree] Child task of "${title}" (branch ${parent.branch}). It lands there${base ? `, not ${base}` : ''}.`,
    'Me: teamree whoami   Commands: teamree guide'
  ].join('\n')
}
