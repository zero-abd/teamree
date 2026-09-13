// A pane exiting, as every client hears about it.
//
// Wired in the order the app wires it — restore first, then register the
// handlers, then wrap them as producers — because that order is what the
// invariant here is about: the panes brought back from the last launch exist
// before any handler does, and they still have to announce their own exits.
// A restored pane and a freshly opened one must be indistinguishable to a
// subscriber, or the sidebar goes on calling a dead agent "working" after every
// restart, which is precisely when a resumed agent pane is the point.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '../../shared/entities'
import type { WorkspaceEvent } from '../../shared/methods'
import type { Response } from '../../shared/protocol'
import { createTerminalService, registerTerminalHandlers } from '../terminals/method-handlers'
import type { TerminalService } from '../terminals/method-handlers'
import { canSpawnPty, testShell, waitUntil } from '../terminals/pty-test-support'
import type { TerminalRecord } from '../terminals/session-restore'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'
import { publishTerminalEvents } from './workspaceEventSources'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_restart'
const RESTORED_ID = 'term_from_last_launch'
const EXIT_CODE = 7

type Harness = {
  terminals: TerminalService
  events: WorkspaceEvent[]
  call: <T>(method: string, params?: unknown) => Promise<T>
  /** Ends every pane that is waiting on it, without typing into any of them. */
  stopFile: string
}

const temporaryDirs: string[] = []
const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A stand-in for an agent CLI that sits there until it is told to stop, then
 * exits with a code of its own. Ending it by touching a file rather than by
 * writing into the pty keeps the pane's own state out of it: a keystroke
 * retires a restored pane's badge and is itself a producer, which would put
 * events in the way of the ones under test.
 */
async function fakeAgent(): Promise<{ checkout: string; binary: string; stopFile: string }> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-exit-events-'))
  temporaryDirs.push(base)
  const checkout = join(base, 'checkout')
  const bin = join(base, 'bin')
  await mkdir(checkout, { recursive: true })
  await mkdir(bin, { recursive: true })
  const stopFile = join(base, 'stop')
  const binary = join(bin, 'claude')
  await writeFile(
    binary,
    `#!/bin/sh\necho READY\nwhile [ ! -f ${stopFile} ]; do sleep 0.05; done\nexit ${EXIT_CODE}\n`,
    'utf8'
  )
  await chmod(binary, 0o755)
  return { checkout, binary, stopFile }
}

/** The runtime as registerHandlers builds it, with one pane already recorded. */
async function startAfterRestart(record: TerminalRecord, checkout: string, stopFile: string): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-exit-events-data-'))
  temporaryDirs.push(dataDir)
  const store = await WorkspaceStore.open(join(dataDir, 'workspace.json'))
  store.putTerminal(record)

  const hub = new SubscriptionHub()
  const context = createRuntimeContext({ version: 'test', store, subscriptions: hub })
  const registry = new MethodRegistry(context)

  const terminals = createTerminalService({
    subscriptions: hub,
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? checkout : undefined),
    layouts: store,
    sessions: store
  })
  services.push(terminals)
  terminals.restoreSessions()
  terminals.reconcileLayouts()
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

  return { terminals, events, call, stopFile }
}

function recordFor(binary: string, checkout: string): TerminalRecord {
  return {
    id: RESTORED_ID,
    worktreeId: WORKTREE,
    cwd: checkout,
    shell: testShell(),
    // An agent pane, because that is the one M10 brings back with its
    // conversation rather than as a plain shell.
    command: binary,
    agent: 'claude',
    agentSessionId: 'session_from_last_launch',
    cols: 80,
    rows: 24,
    createdAt: 0
  }
}

function exitsIn(events: WorkspaceEvent[]): WorkspaceEvent[] {
  return events.filter((event) => event.type === 'terminalExited')
}

describePty('exits on the workspace stream', () => {
  it(
    'announces the exit of a pane that was restored, not only one opened in this run',
    async () => {
      const { checkout, binary, stopFile } = await fakeAgent()
      const harness = await startAfterRestart(recordFor(binary, checkout), checkout, stopFile)

      const restored = harness.terminals.manager.list(WORKTREE).find((pane) => pane.id === RESTORED_ID)
      expect(restored).toMatchObject({ id: RESTORED_ID, running: true, restored: 'agent' })

      const fresh = await harness.call<Terminal>('terminal.create', { worktreeId: WORKTREE, command: binary })
      await waitUntil(
        () => [RESTORED_ID, fresh.id].every((id) => harness.terminals.manager.read(id).includes('READY')),
        'both panes to be running'
      )

      // One deliberate act ends both, so neither one's announcement can be a
      // side effect of anything the other did.
      harness.events.length = 0
      await writeFile(harness.stopFile, '', 'utf8')
      await waitUntil(() => exitsIn(harness.events).length === 2, 'both exits to be published')

      const byTerminal = Object.fromEntries(
        exitsIn(harness.events).map((event) => [(event as { terminalId: string }).terminalId, event])
      )
      expect(byTerminal[RESTORED_ID]).toEqual({
        type: 'terminalExited',
        terminalId: RESTORED_ID,
        exitCode: EXIT_CODE
      })
      // The invariant: the two panes are described identically, one having come
      // back from a previous launch and the other having been opened by a call.
      expect(byTerminal[fresh.id]).toEqual({ type: 'terminalExited', terminalId: fresh.id, exitCode: EXIT_CODE })
      // And the record each client holds is stale now, for both of them.
      expect(harness.events).toContainEqual({ type: 'terminals' })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'stops calling a restored pane running once its process is gone',
    async () => {
      const { checkout, binary, stopFile } = await fakeAgent()
      const harness = await startAfterRestart(recordFor(binary, checkout), checkout, stopFile)
      await waitUntil(() => harness.terminals.manager.read(RESTORED_ID).includes('READY'), 'the pane to be running')

      await writeFile(harness.stopFile, '', 'utf8')
      await waitUntil(() => exitsIn(harness.events).length === 1, 'the exit to be published')

      const panes = await harness.call<Terminal[]>('terminal.list', { worktreeId: WORKTREE })
      expect(panes.find((pane) => pane.id === RESTORED_ID)).toMatchObject({
        running: false,
        exitCode: EXIT_CODE,
        // The pane is not working, and nothing needs to happen for a client to
        // be told so: the exit above already invalidated the list.
        busy: false
      })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says nothing about an exit for a pane the user closed',
    async () => {
      const { checkout, binary, stopFile } = await fakeAgent()
      const harness = await startAfterRestart(recordFor(binary, checkout), checkout, stopFile)
      await waitUntil(() => harness.terminals.manager.read(RESTORED_ID).includes('READY'), 'the pane to be running')

      harness.events.length = 0
      await harness.call('terminal.close', { terminalId: RESTORED_ID })

      // Closing already announced itself; an exit event for a pane no client can
      // list any more would be an exit banner on something that is not there.
      expect(exitsIn(harness.events)).toEqual([])
      expect(harness.events).toContainEqual({ type: 'terminals' })
    },
    TEST_TIMEOUT_MS
  )
})
