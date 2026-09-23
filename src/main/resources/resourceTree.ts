// The table, read per pane.
//
// A pane is its pty child and everything that child started. On unix the
// child is a session leader, so its descendants are reachable by walking
// parent ids from it — which is what this does, from one table, for every
// pane at once. The app is the same walk from its own pid, minus the panes:
// they are children of the main process too, and counting them twice would
// put the whole workspace on the row that says what the app itself costs.
//
// What this deliberately leaves out: a process whose parent has died. The
// kernel reparents it to pid 1, it leaves every tree here, and no row claims
// it. That is the honest answer — nothing this app started still owns it —
// and the alternative, guessing by name, would attribute somebody's own
// editor to a pane because both are called `node`.

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
 * The one thing a kill may do with a pid, or null.
 *
 * Null is the answer for this app's own processes, for a pid nobody here
 * spawned, and for a pane whose child is already gone — every one of them is
 * a pid that, signalled, would reach something other than what the row
 * offered. The caller looks this up in a sample it just took, not the one it
 * drew from: a pid can be reused between two.
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
