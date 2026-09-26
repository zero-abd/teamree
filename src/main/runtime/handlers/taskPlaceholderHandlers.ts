// Task, memory, handoff, template and add-on methods until their branches land:
// reads answer empty, writes refuse as not implemented. Settings are real.

import { isValidBranchPrefix } from '../../../shared/branchName'
import { emptyProjectContext } from '../../../shared/memory'
import { Params } from '../../../shared/methods'
import { ErrorCode } from '../../../shared/protocol'
import { checkWorktreesRoot, defaultWorktreesRoot } from '../../git/worktreesRoot'
import type { MethodRegistry } from '../methodRegistry'
import { notFound, RuntimeError } from '../runtimeError'

export function registerTaskPlaceholderHandlers(registry: MethodRegistry): void {
  const refuse = (method: string) => () => {
    throw notFound(`${method} is not implemented yet`)
  }

  registry.register('message.send', Params.messageSend, refuse('message.send'))
  registry.register('message.list', Params.messageList, () => [])
  registry.register('message.read', Params.messageRead, () => ({ read: 0 }))

  registry.register('project.context', Params.projectContext, ({ worktreeId }) => emptyProjectContext(worktreeId))
  registry.register('memory.note', Params.memoryNote, refuse('memory.note'))
  registry.register('memory.resolve', Params.memoryResolve, refuse('memory.resolve'))
  registry.register('memory.forget', Params.memoryForget, refuse('memory.forget'))
  registry.register('memory.conflicts', Params.memoryConflicts, () => [])

  registry.register('worktree.overlaps', Params.worktreeOverlaps, ({ projectId }) => ({
    projectId,
    overlaps: [],
    readAt: Date.now()
  }))
  registry.register('worktree.usage', Params.worktreeUsage, () => [])

  registry.register('teamwork.handOff', Params.teamworkHandOff, refuse('teamwork.handOff'))
  registry.register('teamwork.handoffs', Params.teamworkHandoffs, () => ({ incoming: [], outgoing: [] }))
  registry.register('teamwork.take', Params.teamworkTake, refuse('teamwork.take'))
  registry.register('teamwork.dismissHandoff', Params.teamworkDismissHandoff, refuse('teamwork.dismissHandoff'))

  registry.register('project.templates', Params.projectTemplates, ({ projectId }) => ({
    projectId,
    templates: [],
    problems: []
  }))
  registry.register('project.saveTemplate', Params.projectSaveTemplate, refuse('project.saveTemplate'))

  registry.register('addons.status', Params.addonsStatus, () => [{ id: 'jac-memory', state: 'off' }])
  registry.register('addons.install', Params.addonsInstall, refuse('addons.install'))
}

/** Per-machine settings, in the workspace file; `worktreesRoot` is where worktrees go with none set. */
export function registerSettingsHandlers(registry: MethodRegistry, worktreesRoot = defaultWorktreesRoot()): void {
  const { store, workspaceEvents } = registry.context
  const answer = () => ({ ...store.runtimeSettings(), worktreesRootFallback: worktreesRoot })
  registry.register('settings.get', Params.settingsGet, answer)
  registry.register('settings.set', Params.settingsSet, async ({ allowInsideRepository, ...changes }) => {
    if (changes.branchPrefix !== undefined) {
      changes.branchPrefix = changes.branchPrefix.trim()
      if (!isValidBranchPrefix(changes.branchPrefix)) {
        throw new RuntimeError(ErrorCode.InvalidParams, `"${changes.branchPrefix}" cannot start a branch name`)
      }
    }
    if (changes.worktreesRoot !== undefined && changes.worktreesRoot.trim() !== '') {
      changes.worktreesRoot = await checkWorktreesRoot(
        changes.worktreesRoot,
        store.listProjects(),
        allowInsideRepository === true
      )
    } else if (changes.worktreesRoot !== undefined) changes.worktreesRoot = ''
    if (store.setRuntimeSettings(changes)) workspaceEvents.emit({ type: 'settings' })
    return answer()
  })
}
