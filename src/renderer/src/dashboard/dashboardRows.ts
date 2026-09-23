// Every pane in every worktree in one list, ordered by what wants a person; states come from
// `agentRows` unchanged so the board and the sidebar speak one vocabulary.

import type { Project, Terminal, Worktree } from '@shared/entities'
import { agentRows, dotTone, TONES_BY_ATTENTION, type AgentRow, type DotTone } from '../sidebar/agentRows'

export type DashboardRow = AgentRow & {
  worktreeId: string
  worktreeName: string
  branch: string
  /** Empty when the project is gone from under the worktree; never guessed at. */
  projectName: string
}

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
  const rank = (row: AgentRow): number => TONES_BY_ATTENTION.indexOf(dotTone(row.activity, row.agent))
  return rows.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      right.quietFor - left.quietFor ||
      left.worktreeName.localeCompare(right.worktreeName) ||
      left.label.localeCompare(right.label) ||
      left.terminalId.localeCompare(right.terminalId)
  )
}

/** How many panes wear each dot, zeros included so the header keeps its shape. */
export function toneCounts(rows: readonly AgentRow[]): Record<DotTone, number> {
  const counts = Object.fromEntries(TONES_BY_ATTENTION.map((tone) => [tone, 0])) as Record<DotTone, number>
  for (const row of rows) counts[dotTone(row.activity, row.agent)] += 1
  return counts
}
