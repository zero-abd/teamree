import type { SystemResources, Terminal, Worktree } from '../../shared/entities.js'
import type { CommandSpec } from '../command-spec.js'
import { formatTable } from '../output.js'

const MB = 1024 * 1024

/**
 * Memory the way a person says it: megabytes to a sensible precision, and
 * gigabytes past a thousand of them. The same rule the status bar uses, said
 * once per side of the socket because `src/shared` is a contract, not a
 * library of formatters.
 */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / MB
  if (megabytes >= 1000) return `${trim(megabytes / 1024, 2)} GB`
  return `${trim(megabytes, megabytes < 10 ? 1 : 0)} MB`
}

function trim(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)))
}

function formatCpu(cpu: number): string {
  return `${cpu.toFixed(1)}%`
}

/**
 * The tree, as a table: totals on the first line, one row per pane under the
 * worktree that owns it, the processes under that, and the app itself last.
 *
 * The same tree the status bar's popover draws, and named the same way — the
 * name somebody gave the pane, or its title — so what a person reads on the
 * rail and what their agent reads over the socket agree.
 */
export function resourcesTable(
  resources: SystemResources,
  terminals: readonly Terminal[],
  worktrees: readonly Worktree[]
): string {
  const worktreeNames = new Map(worktrees.map((worktree) => [worktree.id, worktree.name]))
  const panes = new Map(terminals.map((terminal) => [terminal.id, terminal]))

  const rows: string[][] = []
  for (const pane of resources.panes) {
    const terminal = panes.get(pane.terminalId)
    rows.push([
      worktreeNames.get(pane.worktreeId) ?? pane.worktreeId,
      terminal?.label ?? terminal?.title ?? pane.terminalId,
      String(pane.pid),
      formatCpu(pane.cpu),
      formatBytes(pane.rss),
      ''
    ])
    for (const process of pane.processes) {
      rows.push(['', '', String(process.pid), formatCpu(process.cpu), formatBytes(process.rss), process.command])
    }
  }
  rows.push([
    'teamree',
    'app',
    String(resources.app.pid),
    formatCpu(resources.app.cpu),
    formatBytes(resources.app.rss),
    ''
  ])

  return [
    `total  ${formatCpu(resources.cpu)}  ${formatBytes(resources.rss)}`,
    formatTable(['WORKTREE', 'PANE', 'PID', 'CPU', 'RSS', 'COMMAND'], rows, '')
  ].join('\n')
}

export const resourcesCommands: readonly CommandSpec[] = [
  {
    path: ['resources'],
    summary: 'Show what every pane and the app itself are costing in CPU and memory.',
    details:
      'One ps call: each pane is its child process and everything that started, summed and listed; ' +
      'the app is its own row. rss is resident memory; cpu is the share of one core as ps reports it.',
    examples: ['teamree resources', 'teamree resources --json'],
    run: async (context) => {
      const [resources, terminals, worktrees] = await Promise.all([
        context.client.call('system.resources', {}),
        context.client.call('terminal.list', {}),
        context.client.call('worktree.list', {})
      ])
      return { data: resources, text: resourcesTable(resources, terminals, worktrees) }
    }
  }
]
