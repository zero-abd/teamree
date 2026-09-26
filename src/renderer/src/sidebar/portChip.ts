// What the row's port chip and the Ports dialog say, from the ports main found under each pane.

import type { ListeningPort, Terminal } from '@shared/entities'

export type PortEntry = ListeningPort & { terminalId: string; worktreeId: string }

/** Where a port is opened: localhost, since `[::]` and `0.0.0.0` are not addresses a browser goes to. */
export function portUrl(port: number): string {
  return `http://localhost:${port}`
}

/** Every running pane's ports, lowest first. */
export function listPorts(terminals: readonly Terminal[]): PortEntry[] {
  return terminals
    .filter((terminal) => terminal.running)
    .flatMap((terminal) =>
      (terminal.ports ?? []).map((entry) => ({ ...entry, terminalId: terminal.id, worktreeId: terminal.worktreeId }))
    )
    .sort((a, b) => a.port - b.port || a.pid - b.pid)
}

/** Ports held in more than one worktree, each with those worktrees' ids. */
export function portClashes(terminals: readonly Terminal[]): Map<number, string[]> {
  const holders = new Map<number, Set<string>>()
  for (const entry of listPorts(terminals)) {
    const set = holders.get(entry.port) ?? new Set<string>()
    set.add(entry.worktreeId)
    holders.set(entry.port, set)
  }
  const clashes = new Map<number, string[]>()
  for (const [port, set] of holders) if (set.size > 1) clashes.set(port, [...set].sort())
  return clashes
}

export type PortChip = { label: string; url: string; title: string; clash: boolean }

/** `:5173`, or `:5173 +1` with more; null when the worktree's panes listen on nothing. */
export function portChip(
  terminals: readonly Terminal[],
  worktreeId: string,
  nameOf: (worktreeId: string) => string
): PortChip | null {
  const own = listPorts(terminals).filter((entry) => entry.worktreeId === worktreeId)
  const first = own[0]
  if (first === undefined) return null
  const distinct = [...new Set(own.map((entry) => entry.port))]
  const clashes = portClashes(terminals)
  const lines = distinct.map((port) => {
    const commands = [...new Set(own.filter((entry) => entry.port === port).map((entry) => entry.command))]
    return `:${port}  ${commands.join(', ')}`
  })
  const notes = distinct.flatMap((port) => {
    const others = (clashes.get(port) ?? []).filter((id) => id !== worktreeId).map(nameOf)
    return others.length === 0 ? [] : [`:${port} also in ${others.join(', ')}`]
  })
  return {
    label: distinct.length === 1 ? `:${first.port}` : `:${first.port} +${distinct.length - 1}`,
    url: portUrl(first.port),
    title: [...lines, ...notes].join('\n'),
    clash: notes.length > 0
  }
}
