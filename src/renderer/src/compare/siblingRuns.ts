// A task's runs: the worktrees one task was fanned out to, one per agent, which a compare sets side by side.

import type { AgentKind, Worktree } from '@shared/entities'
import { agentName, worktreeDisplay } from '../sidebar/worktreeDisplay'

export { siblingRuns } from '@shared/runCompare'

/** A run by its agent, `Claude Code 2`; the name when it has none. */
export function runName(worktree: Worktree, kindOf?: (word: string) => AgentKind | undefined): string {
  const agent = worktreeDisplay(worktree, kindOf).agent
  return agent === undefined ? worktree.name : agentName(agent)
}

export function compareTitle(
  worktree: Worktree,
  other: Worktree,
  kindOf?: (word: string) => AgentKind | undefined
): string {
  return `${runName(worktree, kindOf)} vs ${runName(other, kindOf)}`
}
