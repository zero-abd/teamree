// Wires messages into the runtime: the three methods, a person's keystrokes (which hold
// a paste back), and the moments a queued message may go in: a Stop, a pane going quiet.

import { join } from 'node:path'
import { Params } from '../../shared/methods'
import type { GitService } from '../git'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { TerminalService } from '../terminals/method-handlers'
import { MessageService, type MessageServiceOptions } from './messageService'

export function registerMessageHandlers(
  registry: MethodRegistry,
  deps: {
    terminals: TerminalService
    git: GitService
    dataDir: string
    onAsk?: MessageServiceOptions['onAsk']
  }
): MessageService {
  const { store, workspaceEvents } = registry.context
  const manager = deps.terminals.manager
  const service = new MessageService({
    dir: join(deps.dataDir, 'messages'),
    worktrees: {
      list: () => store.listWorktrees(),
      setReport: (worktreeId, report) => {
        const worktree = store.getWorktree(worktreeId)
        if (worktree === undefined) return
        store.putWorktree({ ...worktree, report })
        workspaceEvents.emit({ type: 'worktrees', worktreeIds: [worktreeId] })
      }
    },
    panes: {
      all: () => manager.list(),
      list: (worktreeId) => manager.list(worktreeId),
      write: (terminalId, data) => manager.write(terminalId, data)
    },
    changedPaths: async (worktreeId) =>
      (await deps.git.worktreeChanges({ worktreeId, base: true })).changes.map((change) => change.path),
    onChange: () => workspaceEvents.emit({ type: 'messages' }),
    ...(deps.onAsk === undefined ? {} : { onAsk: deps.onAsk })
  })

  registry.register('message.send', Params.messageSend, (params) => service.send(params))
  registry.register('message.list', Params.messageList, (params) => service.list(params))
  registry.register('message.read', Params.messageRead, ({ ids }) => service.read(ids))

  // Wrapped rather than replaced, as the ledger wraps `terminal.agentEvent`.
  const write = registry.lookup('terminal.write')
  if (write !== undefined) {
    registry.register('terminal.write', Params.terminalWrite, async (params, call) => {
      if (params.byHand !== false) service.delivery.noteTyped(params.terminalId)
      return (await write.handler(params as never, call)) as { written: true }
    })
  }
  const agentEvent = registry.lookup('terminal.agentEvent')
  if (agentEvent !== undefined) {
    registry.register('terminal.agentEvent', Params.terminalAgentEvent, async (params, call) => {
      const terminal = await agentEvent.handler(params as never, call)
      service.delivery.pump()
      return terminal as never
    })
  }
  manager.onTerminalExit((terminalId) => service.delivery.forget(terminalId))
  workspaceEvents.on((event) => {
    if (event.type === 'terminals') service.delivery.pump()
  })
  return service
}
