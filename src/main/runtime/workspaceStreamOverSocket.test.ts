// A mutation made on one connection reaches a subscriber on another. Nothing
// is faked: the bug being prevented lives in the wiring a mock would replace.

import { mkdtemp, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import type { WorkspaceEvent } from '../../shared/methods'
import { createFrameDecoder, type Frame, type Response, type StreamEvent } from '../../shared/protocol'
import { canonicalPath } from '../git/pathIdentity'
import { createTempRepo, type TempRepo } from '../git/testRepository'
import { startRuntime, type Runtime } from './startRuntime'

type Client = {
  socket: Socket
  frames: Frame[]
  /** Sends a request and resolves with its response, ignoring stream frames. */
  call: <T>(method: string, params?: unknown) => Promise<T>
  streamEvents: (subscription: string) => WorkspaceEvent[]
  waitForEvent: (subscription: string, type: WorkspaceEvent['type']) => Promise<WorkspaceEvent>
  close: () => void
}

function isResponse(frame: Frame): frame is Response {
  return 'id' in frame
}

async function openClient(endpoint: string, name: string): Promise<Client> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const pending = connect(endpoint)
    pending.setEncoding('utf8')
    pending.once('error', reject)
    pending.once('connect', () => resolve(pending))
  })

  const frames: Frame[] = []
  const decode = createFrameDecoder()
  socket.on('data', (chunk: Buffer | string) => {
    frames.push(...(decode(typeof chunk === 'string' ? chunk : chunk.toString('utf8')) as Frame[]))
  })

  let counter = 0
  const streamEvents = (subscription: string): WorkspaceEvent[] =>
    frames
      .filter((frame): frame is StreamEvent => !isResponse(frame) && frame.stream === subscription)
      .map((frame) => frame.event as WorkspaceEvent)

  return {
    socket,
    frames,
    call: async <T>(method: string, params: unknown = {}): Promise<T> => {
      counter += 1
      const id = `${name}-${counter}`
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
      const response = await waitUntil(
        () => frames.find((frame): frame is Response => isResponse(frame) && frame.id === id),
        `a response to ${method}`
      )
      if (!response.ok) throw new Error(`${method} failed: ${response.error.code} ${response.error.message}`)
      return response.result as T
    },
    streamEvents,
    waitForEvent: (subscription, type) =>
      waitUntil(
        () => streamEvents(subscription).find((event) => event.type === type),
        `a ${type} event on ${subscription}`
      ),
    close: () => socket.destroy()
  }
}

/** The same wait, for a condition that has no value to hand back. */
function waitForTrue(predicate: () => boolean, description: string): Promise<true> {
  return waitUntil(() => (predicate() ? true : undefined), description)
}

async function waitUntil<T>(read: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let userDataDir: string
let runtime: Runtime
let repo: TempRepo
/**
 * What the bus carries with nobody subscribed; the runtime keeps a listener of its
 * own (teamwork feeds off the same bus).
 */
let restingListeners: number

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'teamree-stream-e2e-'))
  repo = await createTempRepo()
  runtime = await startRuntime({
    userDataDir,
    version: 'test',
    serveCli: true,
    // No Electron in a vitest worker, so the renderer transport stays off.
    serveRenderer: false,
    // And nothing in a test may reach the network.
    checkForUpdates: false,
    onError: () => undefined
  })
  expect(runtime.endpoint).not.toBe('')
  restingListeners = runtime.context.workspaceEvents.listenerCount
}, 30_000)

afterAll(async () => {
  await runtime?.stop()
  await repo?.cleanup()
  await rm(userDataDir, { recursive: true, force: true })
})

describe('workspace stream across connections', () => {
  it('delivers a change made by one client to a subscriber on another', async () => {
    const watcher = await openClient(runtime.endpoint, 'watcher')
    const mutator = await openClient(runtime.endpoint, 'mutator')

    const { subscription } = await watcher.call<{ subscription: string }>('workspace.subscribe')

    // The mutation an agent would make through the CLI.
    const project = await mutator.call<Project>('project.add', { path: repo.repoPath })
    // Compared canonically: the path is stored resolved and separator-normalised.
    expect(project.path).toBe(canonicalPath(repo.repoPath))

    const event = await watcher.waitForEvent(subscription, 'projects')
    expect(event).toEqual({ type: 'projects' })

    // The stream is the subscriber's alone: the mutating client is sent nothing.
    expect(mutator.frames.filter((frame) => !isResponse(frame))).toEqual([])

    // And the subscriber can refetch what changed over its own connection.
    const projects = await watcher.call<Project[]>('project.list')
    expect(projects.map((row) => row.id)).toContain(project.id)

    watcher.close()
    mutator.close()
    // Waited for: the case below counts subscriptions on this same runtime.
    await waitForTrue(
      () =>
        runtime.context.subscriptions.size === 0 && runtime.context.workspaceEvents.listenerCount === restingListeners,
      "this case's clients to be forgotten"
    )
  }, 30_000)

  it("drops a subscription when its client's socket dies", async () => {
    // Asserted on the runtime, not the dead client's frame list: a destroyed socket
    // receives nothing whatever the server does. The subscription and its bus listener
    // must go, and this is the only place the socket 'close' to hub chain runs for real.
    const hub = runtime.context.subscriptions
    const bus = runtime.context.workspaceEvents

    const watcher = await openClient(runtime.endpoint, 'doomed')
    const mutator = await openClient(runtime.endpoint, 'survivor')
    await watcher.call<{ subscription: string }>('workspace.subscribe')
    expect(hub.size).toBe(1)
    expect(bus.listenerCount).toBe(restingListeners + 1)

    watcher.close()
    await waitForTrue(() => hub.size === 0, "the runtime to drop the dead connection's subscription")
    expect(bus.listenerCount).toBe(restingListeners)

    const projects = await mutator.call<Project[]>('project.list')
    // A real mutation with nobody left to hear it; the runtime must keep serving.
    for (const project of projects) await mutator.call('project.remove', { projectId: project.id })
    expect(await mutator.call<Project[]>('project.list')).toEqual([])
    mutator.close()
  }, 30_000)
})
