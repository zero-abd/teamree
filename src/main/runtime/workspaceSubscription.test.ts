// The workspace stream as a subscriber experiences it: real services, real
// mutations dispatched the way a transport dispatches them, and assertions on
// the frames that come back out of the subscription hub.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project, Worktree } from '../../shared/entities'
import type { WorkspaceEvent } from '../../shared/methods'
import type { Response, StreamEvent } from '../../shared/protocol'
import { GitService, registerGitHandlers } from '../git'
import { createGitRunner } from '../git/gitProcess'
import { createDelayedRunner, createTempRepo, type TempRepo } from '../git/testRepository'
import { createTerminalService, registerTerminalHandlers } from '../terminals/method-handlers'
import type { TerminalService } from '../terminals/method-handlers'
import { canSpawnPty } from '../terminals/pty-test-support'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { registerUnsubscribeHandler } from './handlers/unsubscribeHandler'
import { registerWorkspaceSubscribeHandler } from './handlers/workspaceSubscribeHandler'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext, type RuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'
import { publishGitEvents, publishTerminalEvents } from './workspaceEventSources'

const describePty = canSpawnPty() ? describe : describe.skip
const WORKTREE = 'wt_terminals'
const TEST_TIMEOUT_MS = 30_000

type Watcher = {
  connectionId: string
  subscription: string
  events: WorkspaceEvent[]
  /** Waits for `predicate` to hold over the events seen so far. */
  waitFor: (predicate: (events: WorkspaceEvent[]) => boolean, description: string) => Promise<void>
  clear: () => void
}

type Harness = {
  context: RuntimeContext
  hub: SubscriptionHub
  git: GitService
  terminals: TerminalService
  call: <T>(connectionId: string, method: string, params?: unknown) => Promise<T>
  watch: (connectionId: string) => Promise<Watcher>
  dispose: () => Promise<void>
}

type HarnessOptions = { repo?: TempRepo; slowWorktreeAddMs?: number }

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'teamree-workspace-stream-'))
  const store = await WorkspaceStore.open(join(dataDir, 'workspace.json'))
  const hub = new SubscriptionHub()
  const context = createRuntimeContext({ version: 'test', store, subscriptions: hub })
  const registry = new MethodRegistry(context)

  registerUnsubscribeHandler(registry)
  registerWorkspaceSubscribeHandler(registry)

  const terminals = createTerminalService({
    subscriptions: hub,
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? dataDir : undefined),
    layouts: store
  })
  registerTerminalHandlers(registry, terminals)
  publishTerminalEvents(registry, terminals, context.workspaceEvents)

  const baseRunner = createGitRunner()
  const git = new GitService({
    store,
    ...(options.repo === undefined ? {} : { worktreesRoot: options.repo.worktreesRoot }),
    ...(options.slowWorktreeAddMs === undefined
      ? {}
      : {
          // A checkout that takes longer than the coalescing window is what
          // makes the background creating -> ready transition its own event.
          runner: createDelayedRunner(
            baseRunner,
            (args) => args[0] === 'worktree' && args[1] === 'add',
            options.slowWorktreeAddMs
          )
        })
  })
  registerGitHandlers(registry, git)
  publishGitEvents(git, context.workspaceEvents)

  const dispatch: Dispatcher = createDispatcher(registry)
  let requestId = 0

  const call = async <T>(connectionId: string, method: string, params: unknown = {}): Promise<T> => {
    requestId += 1
    const response = (await dispatch({ id: `r${requestId}`, method, params }, { connectionId })) as Response
    if (!response.ok) throw new Error(`${method} failed: ${response.error.code} ${response.error.message}`)
    return response.result as T
  }

  const watch = async (connectionId: string): Promise<Watcher> => {
    const frames: StreamEvent[] = []
    hub.openConnection(connectionId, (frame) => frames.push(frame))
    const { subscription } = await call<{ subscription: string }>(connectionId, 'workspace.subscribe')
    const mine = (): WorkspaceEvent[] =>
      frames.filter((frame) => frame.stream === subscription).map((frame) => frame.event as WorkspaceEvent)

    return {
      connectionId,
      subscription,
      get events() {
        return mine()
      },
      waitFor: async (predicate, description) => {
        const deadline = Date.now() + 5_000
        while (!predicate(mine())) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${description}; saw ${JSON.stringify(mine())}`)
          }
          await sleep(10)
        }
      },
      clear: () => frames.splice(0)
    }
  }

  return {
    context,
    hub,
    git,
    terminals,
    call,
    watch,
    dispose: async () => {
      await terminals.shutdown()
      await git.dispose()
      hub.closeAll()
      await store.flush().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true })
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Longer than the coalescing window, so "nothing more arrived" means it. */
const settle = (): Promise<void> => sleep(150)

const has =
  (type: WorkspaceEvent['type']) =>
  (events: WorkspaceEvent[]): boolean =>
    events.some((event) => event.type === type)

const countOf = (events: WorkspaceEvent[], type: WorkspaceEvent['type']): number =>
  events.filter((event) => event.type === type).length

const harnesses: Harness[] = []
const repos: TempRepo[] = []

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const created = await createHarness(options)
  harnesses.push(created)
  return created
}

async function repository(): Promise<TempRepo> {
  const repo = await createTempRepo()
  repos.push(repo)
  return repo
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((entry) => entry.dispose()))
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
})

describe('workspace stream producers', () => {
  it('announces a project being added and removed', async () => {
    const repo = await repository()
    const app = await harness({ repo })
    const watcher = await app.watch('c1')

    await app.call('c1', 'project.add', { path: repo.repoPath })
    await watcher.waitFor(has('projects'), 'the project invalidation')
  })

  it(
    'announces a worktree at creation and again when it settles',
    async () => {
      const repo = await repository()
      const app = await harness({ repo, slowWorktreeAddMs: 400 })
      const project = await app.call<Project>('c1', 'project.add', { path: repo.repoPath })
      const watcher = await app.watch('c1')

      const worktree = await app.call<Worktree>('c1', 'worktree.create', {
        projectId: project.id,
        name: 'stream check'
      })
      expect(worktree.state).toBe('creating')
      await watcher.waitFor(has('worktrees'), 'the invalidation for the new record')

      // Only the background transition can produce what lands after this point.
      watcher.clear()
      const settled = await app.git.whenSettled(worktree.id)
      expect(settled.state, settled.error).toBe('ready')
      await watcher.waitFor(has('worktrees'), 'the invalidation for creating -> ready')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'collapses the burst from removing a project with several worktrees',
    async () => {
      const repo = await repository()
      const app = await harness({ repo })
      const project = await app.call<Project>('c1', 'project.add', { path: repo.repoPath })
      const first = await app.call<Worktree>('c1', 'worktree.create', { projectId: project.id, name: 'one' })
      const second = await app.call<Worktree>('c1', 'worktree.create', { projectId: project.id, name: 'two' })
      // Settled first, so removal is the in-memory burst under test rather than
      // two checkouts being torn off disk seconds apart.
      await Promise.all([app.git.whenSettled(first.id), app.git.whenSettled(second.id)])

      const watcher = await app.watch('c1')
      // Removal emits one event per worktree plus one for the project itself.
      await app.call('c1', 'project.remove', { projectId: project.id })
      await watcher.waitFor(has('projects'), 'the project invalidation')
      await settle()

      expect(countOf(watcher.events, 'projects')).toBe(1)
      expect(countOf(watcher.events, 'worktrees')).toBe(1)
    },
    TEST_TIMEOUT_MS
  )
})

describe('workspace stream subscribers', () => {
  it('gives concurrent subscribers their own stream and their own teardown', async () => {
    const repo = await repository()
    const app = await harness({ repo })
    const first = await app.watch('c1')
    const second = await app.watch('c2')
    expect(first.subscription).not.toBe(second.subscription)

    await app.call('c1', 'project.add', { path: repo.repoPath })
    await first.waitFor(has('projects'), 'the first subscriber to see the change')
    await second.waitFor(has('projects'), 'the second subscriber to see the change')

    // One subscriber leaving must not disturb the other.
    await app.call('c2', 'unsubscribe', { subscription: second.subscription })
    second.clear()
    await app.call('c1', 'project.remove', { projectId: (await app.call<Project[]>('c1', 'project.list'))[0]!.id })
    await first.waitFor((events) => countOf(events, 'projects') === 2, 'the second change on the live stream')
    await settle()

    expect(second.events).toEqual([])
    expect(app.context.workspaceEvents.listenerCount).toBe(1)
  })

  it('tears a subscription down when its connection drops', async () => {
    const repo = await repository()
    const app = await harness({ repo })
    const watcher = await app.watch('c1')
    expect(app.context.workspaceEvents.listenerCount).toBe(1)

    app.hub.closeConnection('c1')
    expect(app.hub.size).toBe(0)
    // The bus listener goes with the connection, so a dead client costs nothing.
    expect(app.context.workspaceEvents.listenerCount).toBe(0)

    watcher.clear()
    await app.call('c2', 'project.add', { path: repo.repoPath })
    await settle()
    expect(watcher.events).toEqual([])
  })
})

describePty('workspace stream terminal producers', () => {
  it(
    'announces terminals and layouts through create, split and close',
    async () => {
      const app = await harness()
      const watcher = await app.watch('c1')

      const terminal = await app.call<{ id: string }>('c1', 'terminal.create', {
        worktreeId: WORKTREE,
        shell: '/bin/sh',
        command: 'cat'
      })
      await watcher.waitFor(has('terminals'), 'the terminal invalidation')
      expect(watcher.events).toContainEqual({ type: 'layout', worktreeId: WORKTREE })

      watcher.clear()
      const split = await app.call<{ terminal: { id: string } }>('c1', 'terminal.split', {
        terminalId: terminal.id,
        direction: 'row',
        command: 'cat'
      })
      await watcher.waitFor(has('terminals'), 'the invalidation for the split pane')
      expect(watcher.events).toContainEqual({ type: 'layout', worktreeId: WORKTREE })

      watcher.clear()
      await app.call('c1', 'terminal.close', { terminalId: split.terminal.id })
      await watcher.waitFor(has('terminals'), 'the invalidation for the closed pane')
      expect(watcher.events).toContainEqual({ type: 'layout', worktreeId: WORKTREE })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'announces a layout the client set itself',
    async () => {
      const app = await harness()
      const terminal = await app.call<{ id: string }>('c1', 'terminal.create', {
        worktreeId: WORKTREE,
        shell: '/bin/sh',
        command: 'cat'
      })
      const watcher = await app.watch('c1')

      await app.call('c1', 'layout.set', {
        worktreeId: WORKTREE,
        root: { kind: 'leaf', terminalId: terminal.id },
        focusedTerminalId: terminal.id
      })

      await watcher.waitFor(has('layout'), 'the layout invalidation')
      expect(watcher.events).toContainEqual({ type: 'layout', worktreeId: WORKTREE })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'reports a shell that exits on its own, with its exit code',
    async () => {
      const app = await harness()
      const watcher = await app.watch('c1')

      const terminal = await app.call<{ id: string }>('c1', 'terminal.create', {
        worktreeId: WORKTREE,
        shell: '/bin/sh',
        command: 'exit 7'
      })

      await watcher.waitFor(has('terminalExited'), 'the exit invalidation')
      expect(watcher.events).toContainEqual({ type: 'terminalExited', terminalId: terminal.id, exitCode: 7 })
      expect(watcher.events).toContainEqual({ type: 'terminals' })
    },
    TEST_TIMEOUT_MS
  )
})
