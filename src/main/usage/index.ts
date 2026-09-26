// `worktree.usage`: tokens per worktree from the agents' own transcripts.

import { Params } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import { UsageService } from './usageService'

export function registerUsageHandlers(registry: MethodRegistry): UsageService {
  const { store } = registry.context
  const usage = new UsageService({
    worktrees: () => store.listWorktrees(),
    terminals: () => store.listTerminals()
  })
  registry.register('worktree.usage', Params.worktreeUsage, (query) => usage.usage(query))
  return usage
}
