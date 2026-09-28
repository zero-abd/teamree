// What is wrong with workspace.json, for the window's notice, and Retry for a save that failed.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'

export function registerWorkspaceFileHandlers(registry: MethodRegistry): void {
  const { store } = registry.context
  registry.register('workspace.problems', Params.workspaceProblems, async () => store.problems())
  registry.register('workspace.retrySave', Params.workspaceRetrySave, async () => ({ saved: await store.retrySave() }))
}
