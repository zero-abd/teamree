// Which worktree a terminal started from the empty state belongs in.
//
// teamree has no terminal that is not in a worktree — that is the whole shape
// of the app — so "open a terminal" from a window with nothing open has to
// answer "where" before it can do anything. This is that answer, and it is a
// function rather than a line inside the component because it is the one part
// of that button anybody could disagree with.
//
// The order is the order of evidence about what somebody meant:
//
// 1. The tab they had open last, if it is still here. Closing every tab does
//    not mean abandoning the work; it usually means the window was tidied.
// 2. Otherwise the newest worktree, because that is the task in hand.
//
// Only `ready` worktrees count. One still being checked out has no directory to
// start a shell in yet, and one that failed has nothing to start at all — a
// terminal opened in either would fail in a way that reads as the button being
// broken.

import type { Worktree } from '@shared/entities'

export function terminalTarget(worktrees: readonly Worktree[], openWorktreeIds: readonly string[]): Worktree | null {
  const ready = worktrees.filter((worktree) => worktree.state === 'ready')
  for (const id of [...openWorktreeIds].reverse()) {
    const remembered = ready.find((worktree) => worktree.id === id)
    if (remembered) return remembered
  }
  // `createdAt` rather than the array's order: the runtime's list is not
  // promised to be sorted, and the newest is the claim being made.
  return ready.reduce<Worktree | null>(
    (newest, worktree) => (newest === null || worktree.createdAt > newest.createdAt ? worktree : newest),
    null
  )
}
