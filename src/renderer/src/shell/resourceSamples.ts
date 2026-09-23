// What the window keeps between two answers from `system.resources`.
//
// The runtime answers one instant. The sparkline wants the last thirty, per
// row, and the popover wants the panes under the worktrees the sidebar names
// — both of which are this window's to hold, because the runtime has neither
// a history nor a name for anything.

import type { PaneResources, SystemResources, Terminal, Worktree } from '@shared/entities'
import { paneNames } from '../sidebar/agentRows'

/** A minute at the popover's cadence, which is enough to see a build start and end. */
export const SPARKLINE_SAMPLES = 30

/** The key the app's own row keeps its history under. No pane has this id. */
export const APP_ROW = 'app'

/** Readings per row, oldest first. */
export type ResourceHistory = Readonly<Record<string, readonly number[]>>

/**
 * The history with one more sample on every row the sample has, and without
 * any row it does not: a pane that closed takes its line with it.
 */
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

/**
 * The panes under their worktrees, in the sidebar's order and under the
 * sidebar's names — `paneNames`, so two `claude` panes are told apart here
 * the way they are told apart there. A worktree the window cannot name is
 * still a group, under its id: the honest answer, and better than a pane
 * dropped from a list of what the machine is doing.
 */
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
    const known = panes.map((pane) => terminals[pane.terminalId])
    const names = paneNames(known.map((terminal) => terminal ?? { title: '', shell: '' }))
    return {
      worktreeId,
      name: worktrees.find((worktree) => worktree.id === worktreeId)?.name ?? worktreeId,
      panes: panes.map((pane, index) => ({
        pane,
        name: known[index] === undefined ? pane.terminalId : (names[index] ?? pane.terminalId),
        terminal: known[index]
      }))
    }
  })
}
