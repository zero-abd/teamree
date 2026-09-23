// Every pane in every worktree, in one list, ordered by what would make
// somebody look.
//
// The sidebar answers "what is this worktree doing" one worktree at a time,
// which is the wrong shape for the question eight parallel agents actually
// create: not "how is atlas doing" but "which of these wants me". Scanning a
// tree to find that out is exactly the work this view exists to remove.
//
// The states come from `agentRows` unchanged. There is one vocabulary for what
// a pane is doing, and it is the one the sidebar already speaks — a second
// reading of the same PTY would only give a reader two answers to reconcile.

import type { Project, Terminal, Worktree } from '@shared/entities'
import { agentRows, type AgentActivity, type AgentRow } from '../sidebar/agentRows'

export type DashboardRow = AgentRow & {
  worktreeId: string
  worktreeName: string
  branch: string
  /** Empty when the project is gone from under the worktree; never guessed at. */
  projectName: string
}

/**
 * The order attention is owed in.
 *
 * A failure is finished and wrong, so it outranks a question that is merely
 * unanswered; a pane that has asked for something outranks one still working,
 * because yours is the only hand that can move it; a pane still producing
 * output is further along than one that has stopped and said nothing about why;
 * a finished pane is the only one asking for nothing. It is the same precedence
 * `worktreeActivity` collapses a worktree by, deliberately: a dashboard that
 * ranked the five states differently from the sidebar would be teaching a
 * second reading of the same evidence.
 */
export const ACTIVITIES_BY_ATTENTION: readonly AgentActivity[] = ['failed', 'waiting', 'working', 'quiet', 'done']

export type DashboardInput = {
  terminals: readonly Terminal[]
  worktrees: readonly Worktree[]
  projects: readonly Project[]
  now: number
}

/**
 * Panes belonging to a worktree the runtime no longer lists are dropped rather
 * than shown unplaced: a row whose only purpose is to say where to look is
 * worse than no row when it cannot say where.
 */
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

  // Longest-silent first inside a group: between two panes in the same state,
  // the one that has been sitting there is the one being neglected. Ties fall
  // back to names so the list does not reshuffle itself under the pointer every
  // time the clock ticks.
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

/**
 * How many panes are in each state. Every state is present, zeros included, so
 * the header keeps its shape as panes move between them rather than jumping
 * about while somebody is reading it.
 */
export function activityCounts(rows: readonly DashboardRow[]): ActivityCounts {
  const counts: ActivityCounts = { failed: 0, waiting: 0, working: 0, quiet: 0, done: 0 }
  for (const row of rows) counts[row.activity] += 1
  return counts
}
