// Wires the ledger into the runtime: `project.context`, `memory.*`, `worktree.overlaps`,
// and the two moments it re-reads git: a workspace change and an agent stopping or asking.

import type { Terminal } from '../../shared/entities'
import { emptyProjectContext } from '../../shared/memory'
import { Params } from '../../shared/methods'
import type { GitService } from '../git'
import type { MethodRegistry } from '../runtime/methodRegistry'
import { ContextLedger } from './contextLedger'

export function registerContextHandlers(registry: MethodRegistry, git: GitService, dataDir: string): ContextLedger {
  const bus = registry.context.workspaceEvents
  const ledger = new ContextLedger({
    dataDir,
    snapshot: () => git.snapshot(),
    onChange: () => bus.emit({ type: 'memory' })
  })

  registry.register('project.context', Params.projectContext, async ({ format, ...params }) => {
    const context = await ledger.context(params)
    if (format !== 'text') return context
    const { text, tokens, truncated, revision, sources } = context
    return {
      ...emptyProjectContext(params.worktreeId),
      text,
      tokens,
      truncated,
      revision,
      ...(sources ? { sources } : {})
    }
  })
  registry.register('memory.note', Params.memoryNote, (params) => ledger.note(params))
  registry.register('memory.resolve', Params.memoryResolve, (params) => ledger.resolve(params))
  registry.register('memory.forget', Params.memoryForget, (params) => ledger.forget(params))
  registry.register('memory.conflicts', Params.memoryConflicts, ({ worktreeId }) => ledger.conflicts(worktreeId))
  registry.register('memory.claim', Params.memoryClaim, (params) => ledger.claim(params))
  registry.register('memory.unclaim', Params.memoryUnclaim, (params) => ledger.unclaim(params))
  registry.register('worktree.overlaps', Params.worktreeOverlaps, ({ projectId }) => ledger.overlaps(projectId))

  bus.on((event) => {
    if (event.type === 'worktrees' || event.type === 'projects') ledger.schedule()
  })
  // Wrapped rather than replaced: the terminal handler stays the one that records the event.
  const agentEvent = registry.lookup('terminal.agentEvent')
  if (agentEvent !== undefined) {
    registry.register('terminal.agentEvent', Params.terminalAgentEvent, async (params, call) => {
      const terminal = (await agentEvent.handler(params as never, call)) as Terminal
      if (params.event === 'Stop' || params.event === 'Notification') ledger.schedule()
      return terminal
    })
  }
  return ledger
}
