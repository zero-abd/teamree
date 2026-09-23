// Every contract method is registered from the first boot, even the ones nobody
// has written yet. A caller then gets a precise `not_found` saying the feature is
// missing instead of `unknown_method`, which would wrongly suggest a protocol
// mismatch. Real handlers registered afterwards replace these.

import type { z } from 'zod'
import { Params, type MethodName, type ParamsOf } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { notFound } from '../runtimeError'

export function registerPlaceholderHandlers(registry: MethodRegistry): void {
  placeholder(registry, 'project.list', Params.projectList)
  placeholder(registry, 'project.add', Params.projectAdd)
  placeholder(registry, 'project.remove', Params.projectRemove)

  placeholder(registry, 'worktree.list', Params.worktreeList)
  placeholder(registry, 'worktree.get', Params.worktreeGet)
  placeholder(registry, 'worktree.create', Params.worktreeCreate)
  placeholder(registry, 'worktree.remove', Params.worktreeRemove)
  placeholder(registry, 'worktree.status', Params.worktreeStatus)
  placeholder(registry, 'worktree.changes', Params.worktreeChanges)
  placeholder(registry, 'worktree.diff', Params.worktreeDiff)
  placeholder(registry, 'worktree.files', Params.worktreeFiles)
  placeholder(registry, 'worktree.findFiles', Params.worktreeFindFiles)
  placeholder(registry, 'worktree.commit', Params.worktreeCommit)
  placeholder(registry, 'worktree.stageHunk', Params.worktreeStageHunk)
  placeholder(registry, 'worktree.unstageHunk', Params.worktreeUnstageHunk)
  placeholder(registry, 'worktree.log', Params.worktreeLog)
  placeholder(registry, 'worktree.mergePreview', Params.worktreeMergePreview)
  placeholder(registry, 'worktree.push', Params.worktreePush)

  placeholder(registry, 'terminal.list', Params.terminalList)
  placeholder(registry, 'terminal.create', Params.terminalCreate)
  placeholder(registry, 'terminal.write', Params.terminalWrite)
  placeholder(registry, 'terminal.resize', Params.terminalResize)
  placeholder(registry, 'terminal.close', Params.terminalClose)
  placeholder(registry, 'terminal.rename', Params.terminalRename)
  placeholder(registry, 'terminal.read', Params.terminalRead)
  placeholder(registry, 'terminal.subscribe', Params.terminalSubscribe)
  placeholder(registry, 'terminal.split', Params.terminalSplit)
  placeholder(registry, 'terminal.relaunch', Params.terminalRelaunch)

  placeholder(registry, 'layout.get', Params.layoutGet)
  placeholder(registry, 'layout.set', Params.layoutSet)
  placeholder(registry, 'agent.list', Params.agentList)
}

function placeholder<M extends MethodName>(registry: MethodRegistry, method: M, schema: z.ZodType<ParamsOf<M>>): void {
  registry.register(method, schema, () => {
    throw notFound(`${method} is not implemented yet`)
  })
}
