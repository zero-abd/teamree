// A task's runs: the worktrees one task was fanned out to, one per agent, which a compare sets side by side.

import { hasCheckout, type AgentKind, type Worktree } from '@shared/entities'
import { worktreeDisplay } from '../sidebar/worktreeDisplay'

/** The other checkouts of `worktree`'s project given the same task, in the order listed. */
export function siblingRuns(worktree: Worktree, worktrees: readonly Worktree[]): Worktree[] {
  const task = worktree.task?.trim() ?? ''
  if (task === '') return []
  return worktrees.filter(
    (other) =>
      other.id !== worktree.id &&
      other.projectId === worktree.projectId &&
      other.task?.trim() === task &&
      hasCheckout(other)
  )
}

/** A run by its agent, `claude 2`; the name when it has none. */
export function runName(worktree: Worktree, kindOf?: (word: string) => AgentKind | undefined): string {
  return worktreeDisplay(worktree, kindOf).agent?.text ?? worktree.name
}

export function compareTitle(
  worktree: Worktree,
  other: Worktree,
  kindOf?: (word: string) => AgentKind | undefined
): string {
  return `${runName(worktree, kindOf)} vs ${runName(other, kindOf)}`
}
