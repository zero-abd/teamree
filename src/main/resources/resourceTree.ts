// The process table, read per pane by walking parent ids from each pty child;
// the app is the same walk from its own pid minus the panes. A process
// reparented to pid 1 is claimed by no row: guessing by name would be worse.

import type { PaneResources, ResourceProcess, SystemResources } from '../../shared/entities'

/** One pane, as the terminal service knows it: which worktree, which child. */
export type PaneProcess = { terminalId: string; worktreeId: string; pid: number }

export type AggregateInput = {
  sampledAt: number
  processes: readonly ResourceProcess[]
  panes: readonly PaneProcess[]
  appPid: number
}

export function aggregateResources(input: AggregateInput): SystemResources {
  const byPid = new Map<number, ResourceProcess>()
  const children = new Map<number, ResourceProcess[]>()
  for (const process of input.processes) {
    byPid.set(process.pid, process)
    const siblings = children.get(process.ppid)
    if (siblings) siblings.push(process)
    else children.set(process.ppid, [process])
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.pid - b.pid)

  const subtree = (root: number): ResourceProcess[] => {
    const found: ResourceProcess[] = []
    const seen = new Set<number>()
    const queue: number[] = [root]
    while (queue.length > 0) {
      const pid = queue.shift() as number
      if (seen.has(pid)) continue
      seen.add(pid)
      const process = byPid.get(pid)
      if (process) found.push(process)
      for (const child of children.get(pid) ?? []) queue.push(child.pid)
    }
    return found
  }

  const claimed = new Set<number>()
  const panes: PaneResources[] = input.panes.map((pane) => {
    const processes = subtree(pane.pid)
    for (const process of processes) claimed.add(process.pid)
    return { terminalId: pane.terminalId, worktreeId: pane.worktreeId, pid: pane.pid, ...totals(processes), processes }
  })

  const own = subtree(input.appPid).filter((process) => !claimed.has(process.pid))
  const app = { pid: input.appPid, ...totals(own), processes: own }

  return {
    sampledAt: input.sampledAt,
    cpu: round(panes.reduce((sum, pane) => sum + pane.cpu, app.cpu)),
    rss: panes.reduce((sum, pane) => sum + pane.rss, app.rss),
    panes,
    app
  }
}

function totals(processes: readonly ResourceProcess[]): { cpu: number; rss: number } {
  return {
    cpu: round(processes.reduce((sum, process) => sum + process.cpu, 0)),
    rss: processes.reduce((sum, process) => sum + process.rss, 0)
  }
}

/** One decimal, which is all `ps` gave: summing floats invents more. */
function round(cpu: number): number {
  return Math.round(cpu * 10) / 10
}

/** Where a kill is allowed to go: a pane's whole group, or one process in it. */
export type KillTarget = { kind: 'group' | 'process'; pid: number; terminalId: string }

/**
 * The one thing a kill may do with a pid, or null for anything not a pane's.
 * Looked up in a sample just taken, not the one drawn from: pids are reused.
 */
export function killTarget(sample: SystemResources, pid: number): KillTarget | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  for (const pane of sample.panes) {
    if (pane.processes.length === 0) continue
    if (pane.pid === pid) return { kind: 'group', pid, terminalId: pane.terminalId }
    if (pane.processes.some((process) => process.pid === pid))
      return { kind: 'process', pid, terminalId: pane.terminalId }
  }
  return null
}
