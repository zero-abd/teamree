// A pane's running subagents as sidebar rows: nested under whoever started them, timed from their start.

import type { Subagent } from '@shared/entities'

/** Parents before their children, each with its depth; one whose parent is not listed is a root. */
export function subagentTree(subagents: readonly Subagent[]): { subagent: Subagent; depth: number }[] {
  const ids = new Set(subagents.map((subagent) => subagent.id))
  const children = new Map<string, Subagent[]>()
  for (const subagent of subagents) {
    const parent = subagent.parentId !== undefined && ids.has(subagent.parentId) ? subagent.parentId : ''
    children.set(parent, [...(children.get(parent) ?? []), subagent])
  }
  const ordered: { subagent: Subagent; depth: number }[] = []
  const placed = new Set<string>()
  const visit = (parent: string, depth: number): void => {
    for (const subagent of children.get(parent) ?? []) {
      if (placed.has(subagent.id)) continue
      placed.add(subagent.id)
      ordered.push({ subagent, depth })
      visit(subagent.id, depth + 1)
    }
  }
  visit('', 0)
  return ordered
}

/** How long it has run. */
export function subagentElapsed(subagent: Subagent, now: number): number {
  return Math.max(0, now - subagent.startedAt)
}

/** A duration as the agent's own footer writes one: `45s`, `3m 20s`, `1h 5m`. */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The row's hover text. */
export function subagentTitle(subagent: Subagent, now: number): string {
  const facts = [subagent.agentType, elapsedLabel(subagentElapsed(subagent, now))]
  const lines = [subagent.description, facts.filter((fact) => fact !== undefined).join(' · ')]
  if (subagent.branch !== undefined) lines.push(subagent.branch)
  return lines.join('\n')
}
