// The agent's word reaching every window.
//
// A hook reports to the runtime over the CLI socket, and the window drawing
// the sidebar is not the caller. The only way it hears is the workspace
// stream, so `terminal.agentEvent` has to announce itself there like every
// other change to a pane — or the one state this app most needs to show
// changes on the record and nowhere on screen.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '../../shared/entities'
import type { WorkspaceEvent } from '../../shared/methods'
import type { Response } from '../../shared/protocol'
import { createTerminalService, registerTerminalHandlers } from '../terminals/method-handlers'
import type { TerminalService } from '../terminals/method-handlers'
import { canSpawnPty } from '../terminals/pty-test-support'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'
import { publishTerminalEvents } from './workspaceEventSources'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_hooked'

const temporaryDirs: string[] = []
const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runtime(): Promise<{
  events: WorkspaceEvent[]
  call: <T>(method: string, params?: unknown) => Promise<T>
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-agent-event-stream-'))
  temporaryDirs.push(dataDir)
  const store = await WorkspaceStore.open(join(dataDir, 'workspace.json'))
  const hub = new SubscriptionHub()
  const context = createRuntimeContext({ version: 'test', store, subscriptions: hub })
  const registry = new MethodRegistry(context)
  const terminals = createTerminalService({
    subscriptions: hub,
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? dataDir : undefined),
    layouts: store
  })
  services.push(terminals)
  registerTerminalHandlers(registry, terminals)
  publishTerminalEvents(registry, terminals, context.workspaceEvents)

  const events: WorkspaceEvent[] = []
  context.workspaceEvents.on((event) => events.push(event))

  const dispatch: Dispatcher = createDispatcher(registry)
  let requestId = 0
  const call = async <T>(method: string, params: unknown = {}): Promise<T> => {
    requestId += 1
    const response = (await dispatch({ id: `r${requestId}`, method, params }, { connectionId: 'c1' })) as Response
    if (!response.ok) throw new Error(`${method} failed: ${response.error.code} ${response.error.message}`)
    return response.result as T
  }
  return { events, call }
}

describePty('terminal.agentEvent on the workspace stream', () => {
  it(
    'invalidates the terminals collection, so a window re-reads the pane',
    async () => {
      const app = await runtime()
      const terminal = await app.call<Terminal>('terminal.create', { worktreeId: WORKTREE })
      app.events.length = 0

      const said = await app.call<Terminal>('terminal.agentEvent', {
        terminalId: terminal.id,
        event: 'Notification',
        at: 1_000,
        detail: 'permission_prompt'
      })
      expect(said.agentEvent?.event).toBe('Notification')
      expect(app.events.some((event) => event.type === 'terminals')).toBe(true)
    },
    TEST_TIMEOUT_MS
  )
})
