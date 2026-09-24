// Every pane in every worktree in one list, ordered by what wants a person; states come from
// `agentRows` unchanged so the board and the sidebar speak one vocabulary.

import type { Layout, Project, Terminal, Worktree } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { collectLeaves } from '../panes/paneLayout'
import { agentRows, dotTone, TONES_BY_ATTENTION, type AgentRow, type DotTone } from '../sidebar/agentRows'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'
import { worktreeOrder } from '../sidebar/worktreeOrder'

export type DashboardRow = AgentRow & {
  worktreeId: string
  /** See `worktreeLabel`. */
  worktreeName: string
  /** Absent when it only repeats the name; see `worktreeDisplay`. */
  branch?: string
  /** Empty when the project is gone from under the worktree; never guessed at. */
  projectName: string
}

export type DashboardInput = {
  terminals: readonly Terminal[]
  worktrees: readonly Worktree[]
  projects: readonly Project[]
  /** Each worktree's split tree, for its tab order; a worktree not yet read keeps opening order. */
  layouts?: Readonly<Record<string, Pick<Layout, 'root'>>>
  now: number
  /** Each pane's last printed line, keyed by terminal id; see `usePaneEvidence`. */
  evidence?: Readonly<Record<string, string | null>>
}

/** Panes of a worktree the runtime no longer lists are dropped: a row that cannot say where is worse than none. */
export function dashboardRows(input: DashboardInput): DashboardRow[] {
  const projectName = new Map(input.projects.map((project) => [project.id, project.name]))
  const sidebarOrder = worktreeOrder(input.projects, input.worktrees)

  const keyed = input.worktrees.flatMap((worktree) => {
    const display = worktreeDisplay(worktree)
    const tabs = collectLeaves(input.layouts?.[worktree.id]?.root ?? null).map((leaf) => leaf.terminalId)
    const place = sidebarOrder.indexOf(worktree)
    return agentRows(input.terminals, worktree, input.now, input.evidence).map((row, opened) => ({
      place: place === -1 ? sidebarOrder.length : place,
      tab: tabs.includes(row.terminalId) ? tabs.indexOf(row.terminalId) : tabs.length + opened,
      row: {
        ...row,
        // The pane named after its worktree would repeat the next column; its agent says what it is.
        label: row.agent !== undefined && row.label === display.title ? harnessName(row.agent) : row.label,
        worktreeId: worktree.id,
        worktreeName: worktreeLabel(display),
        ...(display.branch === undefined ? {} : { branch: display.branch }),
        projectName: projectName.get(worktree.projectId) ?? ''
      }
    }))
  })

  // Nothing that moves with the clock: a row changes place only when its state does.
  const rank = (row: AgentRow): number => TONES_BY_ATTENTION.indexOf(dotTone(row.activity, row.agent))
  return keyed
    .sort((left, right) => rank(left.row) - rank(right.row) || left.place - right.place || left.tab - right.tab)
    .map((entry) => entry.row)
}

/** How many panes are in each state, zeros included. */
export function toneCounts(rows: readonly AgentRow[]): Record<DotTone, number> {
  const counts = Object.fromEntries(TONES_BY_ATTENTION.map((tone) => [tone, 0])) as Record<DotTone, number>
  for (const row of rows) counts[dotTone(row.activity, row.agent)] += 1
  return counts
}

/** Panes asking or failed, in every worktree, and the first of them in the board's order. */
export function attention(rows: readonly DashboardRow[]): {
  asking: number
  failed: number
  first: DashboardRow | null
} {
  const owed = rows.filter((row) => row.activity === 'waiting' || row.activity === 'failed')
  return {
    asking: owed.filter((row) => row.activity === 'waiting').length,
    failed: owed.filter((row) => row.activity === 'failed').length,
    first: owed[0] ?? null
  }
}
