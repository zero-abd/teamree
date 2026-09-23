// Every pane in every worktree in one list, ordered by what wants a person; states come from
// `agentRows` unchanged so the board and the sidebar speak one vocabulary.

import type { Project, Terminal, Worktree } from '@shared/entities'
import { agentRows, type AgentActivity, type AgentRow } from '../sidebar/agentRows'

export type DashboardRow = AgentRow & {
  worktreeId: string
  worktreeName: string
  branch: string
  /** Empty when the project is gone from under the worktree; never guessed at. */
  projectName: string
}

/** The order attention is owed in: failed, asking, working, quiet, done; `worktreeActivity`'s precedence. */
export const ACTIVITIES_BY_ATTENTION: readonly AgentActivity[] = ['failed', 'waiting', 'working', 'quiet', 'done']

export type DashboardInput = {
  terminals: readonly Terminal[]
  worktrees: readonly Worktree[]
  projects: readonly Project[]
  now: number
}

/** Panes of a worktree the runtime no longer lists are dropped: a row that cannot say where is worse than none. */
export function dashboardRows(input: DashboardInput): DashboardRow[] {
  const projectName = new Map(input.projects.map((project) => [project.id, project.name]))

  const rows = input.worktrees.flatMap((worktree) =>
    agentRows(input.terminals, worktree.id, input.now).map((row) => ({
      ...row,
      worktreeId: worktree.id,
      worktreeName: worktree.name,
      branch: worktree.branch,
      projectName: projectName.get(worktree.projectId) ?? ''
    }))
  )

  // Longest-silent first within a state; ties fall back to names so the clock tick does not reshuffle.
  return rows.sort(
    (left, right) =>
      ACTIVITIES_BY_ATTENTION.indexOf(left.activity) - ACTIVITIES_BY_ATTENTION.indexOf(right.activity) ||
      right.quietFor - left.quietFor ||
      left.worktreeName.localeCompare(right.worktreeName) ||
      left.label.localeCompare(right.label) ||
      left.terminalId.localeCompare(right.terminalId)
  )
}

export type ActivityCounts = Record<AgentActivity, number>

/** How many panes are in each state, zeros included so the header keeps its shape. */
export function activityCounts(rows: readonly DashboardRow[]): ActivityCounts {
  const counts: ActivityCounts = { failed: 0, waiting: 0, working: 0, quiet: 0, done: 0 }
  for (const row of rows) counts[row.activity] += 1
  return counts
}
