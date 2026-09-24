// What the window keeps between two `system.resources` answers: per-row history for the sparkline and
// the sidebar's names; the runtime has neither.

import type { PaneResources, SystemResources, Terminal, Worktree } from '@shared/entities'
import { paneNamesById } from '../sidebar/agentRows'
import { worktreeDisplay, worktreeLabel } from '../sidebar/worktreeDisplay'

/** A minute at the popover's cadence, which is enough to see a build start and end. */
export const SPARKLINE_SAMPLES = 30

/** The key the app's own row keeps its history under. No pane has this id. */
export const APP_ROW = 'app'

/** Readings per row, oldest first. */
export type ResourceHistory = Readonly<Record<string, readonly number[]>>

/** The history plus one sample per row present; a closed pane's row is dropped. */
export function recordSample(history: ResourceHistory, sample: SystemResources): ResourceHistory {
  const next: Record<string, readonly number[]> = {}
  const push = (key: string, cpu: number): void => {
    next[key] = [...(history[key] ?? []), cpu].slice(-SPARKLINE_SAMPLES)
  }
  for (const pane of sample.panes) push(pane.terminalId, pane.cpu)
  push(APP_ROW, sample.app.cpu)
  return next
}

const MB = 1024 * 1024

/** Memory the way a person says it. The CLI says it the same way, in its own copy. */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / MB
  if (megabytes >= 1000) return `${trim(megabytes / 1024, 2)} GB`
  return `${trim(megabytes, megabytes < 10 ? 1 : 0)} MB`
}

function trim(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)))
}

export function formatCpu(cpu: number): string {
  return `${cpu.toFixed(1)}%`
}

export type ResourceRow = { pane: PaneResources; name: string; terminal: Terminal | undefined }

export type ResourceGroup = { worktreeId: string; name: string; panes: ResourceRow[] }

/** The panes under their worktrees in sidebar order and names; an unnamed worktree is grouped by id. */
export function groupByWorktree(
  sample: SystemResources,
  worktrees: readonly Worktree[],
  terminals: Readonly<Record<string, Terminal>>
): ResourceGroup[] {
  const byWorktree = new Map<string, PaneResources[]>()
  for (const pane of sample.panes) {
    const rows = byWorktree.get(pane.worktreeId)
    if (rows) rows.push(pane)
    else byWorktree.set(pane.worktreeId, [pane])
  }

  const order = [
    ...worktrees.map((worktree) => worktree.id).filter((id) => byWorktree.has(id)),
    ...[...byWorktree.keys()].filter((id) => !worktrees.some((worktree) => worktree.id === id))
  ]

  return order.map((worktreeId) => {
    const panes = byWorktree.get(worktreeId) ?? []
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    const names = paneNamesById(
      Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId),
      worktree
    )
    return {
      worktreeId,
      name: worktree === undefined ? worktreeId : worktreeLabel(worktreeDisplay(worktree)),
      panes: panes.map((pane) => ({
        pane,
        name: names[pane.terminalId] ?? pane.terminalId,
        terminal: terminals[pane.terminalId]
      }))
    }
  })
}
