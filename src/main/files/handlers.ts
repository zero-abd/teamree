// `file.read` and `file.write`. Neither is on `PEER_METHODS`: a teammate across
// a relay has no business reading files off this machine.

import { Params } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import { notFound } from '../runtime/runtimeError'
import { readWorktreeFile, writeWorktreeFile } from './worktreeFile'

export function registerFileHandlers(registry: MethodRegistry): void {
  const worktreePath = (worktreeId: string): string => {
    const worktree = registry.context.store.getWorktree(worktreeId)
    if (!worktree) throw notFound(`no such worktree: ${worktreeId}`)
    return worktree.path
  }
  registry.register('file.read', Params.fileRead, (params) =>
    readWorktreeFile({
      worktreeId: params.worktreeId,
      worktreePath: worktreePath(params.worktreeId),
      path: params.path
    })
  )
  registry.register('file.write', Params.fileWrite, async (params) => {
    const written = await writeWorktreeFile({
      worktreeId: params.worktreeId,
      worktreePath: worktreePath(params.worktreeId),
      path: params.path,
      content: params.content
    })
    // The watcher reports this too, but not on a machine whose watch is degraded.
    registry.context.workspaceEvents.emit({ type: 'worktrees' })
    return written
  })
}
