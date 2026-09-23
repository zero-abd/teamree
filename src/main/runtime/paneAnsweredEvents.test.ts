// What a keystroke retires: the `resumed` badge, the bell, and the agent's own
// word that it is waiting. All are cleared inside the pty session, so the manager
// reports the edge and this file holds it to it. Wired as the app wires it, real pty.

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
const WORKTREE = 'wt_typed'
const RESTORED_ID = 'term_from_last_launch'

type Harness = {
  terminals: TerminalService
  events: WorkspaceEvent[]
  call: <T>(method: string, params?: unknown) => Promise<T>
  checkout: string
  binary: string
}

const temporaryDirs: string[] = []
const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * An agent that says one thing, rings the bell, and waits. Never reads stdin, so a
 * keystroke produces no output of its own.
 */
async function fakeAgent(): Promise<{ checkout: string; binary: string }> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-answered-'))
  temporaryDirs.push(base)
  const checkout = join(base, 'checkout')
  const bin = join(base, 'bin')
  await mkdir(checkout, { recursive: true })
  await mkdir(bin, { recursive: true })
  const binary = join(bin, 'claude')
  await writeFile(binary, "#!/bin/sh\nprintf 'READY\\a'\nwhile true; do sleep 60; done\n", 'utf8')
  await chmod(binary, 0o755)
  return { checkout, binary }
}

/** The runtime as registerHandlers builds it, with one pane already recorded. */
async function startAfterRestart(): Promise<Harness> {
  const { checkout, binary } = await fakeAgent()
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-answered-data-'))
  temporaryDirs.push(dataDir)
  const store = await WorkspaceStore.open(join(dataDir, 'workspace.json'))
  store.putTerminal(recordFor(binary, checkout))

  const hub = new SubscriptionHub()
  const context = createRuntimeContext({ version: 'test', store, subscriptions: hub })
  const registry = new MethodRegistry(context)

  const terminals = createTerminalService({
    subscriptions: hub,
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? checkout : undefined),
    layouts: store,
    sessions: store,
    // Said here rather than probed from the home directory of whoever runs this suite.
    conversationEvidence: () => 'present'
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

  return { terminals, events, call, checkout, binary }
}

function recordFor(binary: string, checkout: string): TerminalRecord {
  return {
    id: RESTORED_ID,
    worktreeId: WORKTREE,
    cwd: checkout,
    shell: testShell(),
    command: binary,
    agent: 'claude',
    agentSessionId: 'session_from_last_launch',
    typed: true,
    cols: 80,
    rows: 24,
    createdAt: 0
  }
}

function invalidations(events: WorkspaceEvent[]): WorkspaceEvent[] {
  return events.filter((event) => event.type === 'terminals')
}

function paneIn(harness: Harness, terminalId: string): Terminal {
  const pane = harness.terminals.manager.list(WORKTREE).find((each) => each.id === terminalId)
  if (!pane) throw new Error(`no pane ${terminalId}`)
  return pane
}

describePty('a keystroke that retires a badge', () => {
  it(
    'announces the restored badge leaving a pane somebody typed into',
    async () => {
      const harness = await startAfterRestart()
      await waitUntil(() => harness.terminals.manager.read(RESTORED_ID).includes('READY'), 'the pane to be running')
      expect(paneIn(harness, RESTORED_ID).restored).toBe('agent')

      harness.events.length = 0
      await harness.call('terminal.write', { terminalId: RESTORED_ID, data: 'y' })

      expect(paneIn(harness, RESTORED_ID).restored).toBeUndefined()
      // Once: a window needs telling exactly as many times as the badge changed.
      expect(invalidations(harness.events)).toEqual([{ type: 'terminals' }])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'announces the bell going out when somebody answers the pane',
    async () => {
      const harness = await startAfterRestart()
      // A second pane opened this run, so only the bell is being watched.
      const asking = await harness.call<Terminal>('terminal.create', {
        worktreeId: WORKTREE,
        command: harness.binary
      })
      await waitUntil(() => paneIn(harness, asking.id).lastBellAt !== undefined, 'the pane to ring its bell')

      harness.events.length = 0
      await harness.call('terminal.write', { terminalId: asking.id, data: 'y' })

      // A bell that outlives the answer is a row asking for what it was already given.
      expect(paneIn(harness, asking.id).lastBellAt).toBeUndefined()
      expect(invalidations(harness.events)).toEqual([{ type: 'terminals' }])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'announces the agent’s own request leaving when somebody answers it, and nothing after a turn that ended',
    async () => {
      const harness = await startAfterRestart()
      const asking = await harness.call<Terminal>('terminal.create', {
        worktreeId: WORKTREE,
        command: harness.binary
      })
      await waitUntil(() => paneIn(harness, asking.id).lastBellAt !== undefined, 'the pane to ring its bell')
      // The bell answered first, so the next keystroke retires the agent's word alone
      // — all a Claude Code pane ever shows, since it rings no bell.
      await harness.call('terminal.write', { terminalId: asking.id, data: 'y' })
      expect(paneIn(harness, asking.id).lastBellAt).toBeUndefined()

      await harness.call('terminal.agentEvent', { terminalId: asking.id, event: 'Notification', at: 1 })
      harness.events.length = 0
      await harness.call('terminal.write', { terminalId: asking.id, data: 'y' })

      expect(paneIn(harness, asking.id).agentEvent).toBeUndefined()
      expect(invalidations(harness.events)).toEqual([{ type: 'terminals' }])

      // A turn that ended stays ended: no record change, no redraw.
      await harness.call('terminal.agentEvent', { terminalId: asking.id, event: 'Stop', at: 2 })
      harness.events.length = 0
      await harness.call('terminal.write', { terminalId: asking.id, data: 'next prompt' })

      expect(paneIn(harness, asking.id).agentEvent).toEqual({ event: 'Stop', at: 2 })
      expect(invalidations(harness.events)).toEqual([])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'says nothing when the emulator answers the program rather than a person',
    async () => {
      const harness = await startAfterRestart()
      await waitUntil(() => paneIn(harness, RESTORED_ID).lastBellAt !== undefined, 'the pane to ring its bell')

      harness.events.length = 0
      // A cursor-position report, which a full-screen agent asks for constantly.
      await harness.call('terminal.write', { terminalId: RESTORED_ID, data: '[1;1R', byHand: false })

      // Neither badge moved, so no window has anything to redraw.
      expect(paneIn(harness, RESTORED_ID).restored).toBe('agent')
      expect(paneIn(harness, RESTORED_ID).lastBellAt).toBeDefined()
      expect(invalidations(harness.events)).toEqual([])
    },
    TEST_TIMEOUT_MS
  )
})
