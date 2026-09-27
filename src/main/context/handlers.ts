// Wires the ledger into the runtime: `project.context`, `memory.*`, `worktree.overlaps`, the Jac Graph
// Memory add-on behind them, and the two moments it re-reads git: a workspace change and an agent stopping or asking.

import { teammatesHeard, type TeammatePresence, type Terminal } from '../../shared/entities'
import { emptyProjectContext } from '../../shared/memory'
import { Params } from '../../shared/methods'
import type { GitService } from '../git'
import type { CallContext, MethodRegistry } from '../runtime/methodRegistry'
import { notFound } from '../runtime/runtimeError'
import { ContextLedger, type TeammatePaths } from './contextLedger'
import { JacAddon } from './jacAddon'

export function registerContextHandlers(registry: MethodRegistry, git: GitService, dataDir: string): ContextLedger {
  const bus = registry.context.workspaceEvents
  const store = registry.context.store
  const addon: JacAddon = new JacAddon({
    userDataDir: dataDir,
    enabled: () => store.runtimeSettings().jacMemoryAddon,
    setEnabled: (on) => {
      if (store.setRuntimeSettings({ jacMemoryAddon: on })) bus.emit({ type: 'settings' })
    },
    onChange: () => bus.emit({ type: 'addons' }),
    greet: () => ledger.providerSnapshot(),
    app: `teamree ${registry.context.version}`
  })
  const ledger: ContextLedger = new ContextLedger({
    dataDir,
    snapshot: () => git.snapshot(),
    onChange: () => bus.emit({ type: 'memory' }),
    warnAgents: () => store.runtimeSettings().warnAgentsAboutOverlaps,
    providers: () => addon.providers(),
    onClose: () => addon.close()
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
  registry.register('memory.list', Params.memoryList, ({ projectId }) => ledger.list(projectId))
  registry.register('memory.check', Params.memoryCheck, ({ worktreeId, terminalId, path, hook }) => {
    const owner =
      worktreeId ?? registry.context.store.listTerminals().find((terminal) => terminal.id === terminalId)?.worktreeId
    if (owner === undefined) throw notFound(`No pane "${terminalId ?? ''}"`)
    return ledger.check({ worktreeId: owner, path, ...(hook === undefined ? {} : { hook }) })
  })
  /** Teammates' live worktrees and their changed paths, as presence carries them; none with teamwork off. */
  const teammatesOf = async (projectId: string, call: CallContext): Promise<TeammatePaths[]> => {
    const presence = registry.lookup('teamwork.presence')
    try {
      const read = (await presence?.handler({ projectId } as never, call)) as TeammatePresence | undefined
      return (teammatesHeard(read)?.worktrees ?? []).flatMap((worktree) =>
        worktree.paths === undefined || worktree.stage === 'landed'
          ? []
          : [{ handle: worktree.handle, worktreeId: worktree.id, name: worktree.name, paths: worktree.paths }]
      )
    } catch {
      return []
    }
  }
  registry.register('worktree.overlaps', Params.worktreeOverlaps, async ({ projectId }, call) =>
    ledger.overlaps(projectId, await teammatesOf(projectId, call))
  )
  registry.register('memory.risk', Params.memoryRisk, async ({ worktreeId, paths }, call) => {
    const projectId = store.getWorktree(worktreeId)?.projectId
    if (projectId === undefined) throw notFound(`No worktree "${worktreeId}"`)
    const teammates = (await teammatesOf(projectId, call)).map((row) => ({ ...row, paths: [...row.paths] }))
    return ledger.risk({ worktreeId, ...(paths === undefined ? {} : { paths }), teammates })
  })
  registry.register('memory.why', Params.memoryWhy, (params) => ledger.why(params))
  registry.register('addons.status', Params.addonsStatus, () => [addon.status()])
  registry.register('addons.install', Params.addonsInstall, () => addon.install())

  bus.on((event) => {
    if (event.type === 'worktrees') ledger.schedule(event.worktreeIds)
    if (event.type === 'projects') ledger.schedule()
    if (event.type === 'settings') addon.sync()
  })
  addon.sync()
  // Wrapped rather than replaced: the terminal handler stays the one that records the event.
  const agentEvent = registry.lookup('terminal.agentEvent')
  if (agentEvent !== undefined) {
    registry.register('terminal.agentEvent', Params.terminalAgentEvent, async (params, call) => {
      const terminal = (await agentEvent.handler(params as never, call)) as Terminal
      if (params.event === 'Stop' || params.event === 'Notification') ledger.schedule([terminal.worktreeId])
      return terminal
    })
  }
  return ledger
}
