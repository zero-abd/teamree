// Walking the parent/child relation between worktrees, the same way in the runtime, CLI and window.

import type { Worktree } from './entities'

/** Every worktree under this one, each directly after its parent. A cycle in a hand-edited file ends the walk. */
export function descendantsOf<T extends Pick<Worktree, 'id' | 'parentId'>>(
  worktrees: readonly T[],
  worktreeId: string
): T[] {
  const seen = new Set([worktreeId])
  const walk = (parentId: string): T[] =>
    worktrees.flatMap((worktree) => {
      if (worktree.parentId !== parentId || seen.has(worktree.id)) return []
      seen.add(worktree.id)
      return [worktree, ...walk(worktree.id)]
    })
  return walk(worktreeId)
}
