// Task, memory, handoff, template and add-on methods until their branches land:
// reads answer empty, writes refuse as not implemented. Settings are real.

import { emptyProjectContext } from '../../../shared/memory'
import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { notFound } from '../runtimeError'

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

/** Settings › Teamwork, Show Cost and Add-ons: per machine, in the workspace file. */
export function registerSettingsHandlers(registry: MethodRegistry): void {
  const { store, workspaceEvents } = registry.context
  registry.register('settings.get', Params.settingsGet, () => store.runtimeSettings())
  registry.register('settings.set', Params.settingsSet, (changes) => {
    if (store.setRuntimeSettings(changes)) workspaceEvents.emit({ type: 'settings' })
    return store.runtimeSettings()
  })
}
