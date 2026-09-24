// Picking the winner of a fanned-out task: the name the kept run goes by once it has no siblings.

import type { Worktree } from '../../shared/entities'

// `name agent 2` before `name agent`, as `taskNamesForAgents` writes them.
const RUN_SHAPES = [/^(.*\S)\s+\S+\s+\d+$/u, /^(.*\S)\s+\S+$/u]

function runBase(name: string): string | null {
  for (const shape of RUN_SHAPES) {
    const base = shape.exec(name.trim())?.[1]
    if (base !== undefined) return base
  }
  return null
}

/** The task's name without the agent word, when every sibling's name is that plus an agent; else null. */
export function keptName(kept: Pick<Worktree, 'name'>, siblings: readonly Pick<Worktree, 'name'>[]): string | null {
  const base = runBase(kept.name)
  if (base === null || siblings.length === 0) return null
  return siblings.every((sibling) => runBase(sibling.name) === base) ? base : null
}
