// The renderer's path to the runtime. `src/preload/index.ts` repeats the channel
// literals because it cannot import a main-process module, so the strings are
// checked here, plus one real round trip. No Electron: `ipcMain` is faked.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response, StreamEvent } from '../../shared/protocol'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher } from './dispatcher'
import { registerHandlers } from './handlers/registerHandlers'
import { RPC_CALL_CHANNEL, RPC_RELEASE_CHANNEL, RPC_STREAM_CHANNEL } from './ipcChannels'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Every `teamree:`-prefixed channel literal a file names, in source order. */
async function channelsNamedIn(relativePath: string): Promise<string[]> {
  const source = await readFile(join(repoRoot, relativePath), 'utf8')
  return [...source.matchAll(/'(teamree:[^']+)'/g)].map((match) => match[1] as string)
}

/** The same literals, keyed by the constant each is bound to. */
async function channelConstantsIn(relativePath: string): Promise<Record<string, string>> {
  const source = await readFile(join(repoRoot, relativePath), 'utf8')
  const entries = [...source.matchAll(/const (RPC_\w+) = '(teamree:[^']+)'/g)]
  return Object.fromEntries(entries.map((match) => [match[1] as string, match[2] as string]))
}

describe('the renderer transport names one set of channels', () => {
  it('spells the RPC channels the same way in the preload as in ipcChannels', async () => {
    const main = await channelConstantsIn('src/main/runtime/ipcChannels.ts')
    const preload = await channelConstantsIn('src/preload/index.ts')

    // Keyed by constant, so a value moved onto the wrong name reads as a mismatch.
    expect(preload).toEqual(main)
    // And the constants really are the three the bridge installs.
    expect(Object.values(main).sort()).toEqual([RPC_CALL_CHANNEL, RPC_RELEASE_CHANNEL, RPC_STREAM_CHANNEL].sort())
  })

  it('leaves no channel the preload speaks that the main process does not serve', async () => {
    const preload = new Set(await channelsNamedIn('src/preload/index.ts'))
    const served = new Set([
      ...(await channelsNamedIn('src/main/runtime/ipcChannels.ts')),
      // The folder picker is handled straight off `ipcMain`, spelled inline at both ends.
      ...(await channelsNamedIn('src/main/index.ts')),
      // "Reveal in Finder" keeps its channel beside the module that serves it. Listed
      // explicitly rather than by walking `src/main`: adding a channel should make
      // somebody come here and say where it is answered; a glob would adopt the next one.
      ...(await channelsNamedIn('src/main/reveal/revealPath.ts')),
      ...(await channelsNamedIn('src/main/reveal/openPath.ts')),
      // The menu bar's two, the same arrangement.
      ...(await channelsNamedIn('src/main/menuBar.ts')),
      // The agent notifications' two, the same again.
      ...(await channelsNamedIn('src/main/agentNotices.ts')),
      // Keep-awake's one, outward only.
      ...(await channelsNamedIn('src/main/keepAwake.ts')),
      // Unsaved files: the list out, the question in, its answer out.
      ...(await channelsNamedIn('src/main/unsavedFiles.ts')),
      // Invitation links: the one that launched the app, taken; each after, sent.
      ...(await channelsNamedIn('src/main/invitationLinks.ts'))
    ])

    expect([...preload].filter((channel) => !served.has(channel))).toEqual([])
    expect([...served].filter((channel) => !preload.has(channel))).toEqual([])
  })
})

// --- the round trip -------------------------------------------------------

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const listeners = new Map<string, Handler[]>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: (channel: string, listener: Handler) => listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
    removeAllListeners: (channel: string) => listeners.delete(channel)
  }
}))

const { installIpcBridge } = await import('./ipcBridge')

/** Just enough WebContents for the bridge: an id, a mailbox, and `once`. */
function fakeWindow(id: number): { contents: unknown; streamed: StreamEvent[]; navigate: () => void } {
  const streamed: StreamEvent[] = []
  const once = new Map<string, () => void>()
  const contents = {
    id,
    isDestroyed: () => false,
    send: (channel: string, frame: StreamEvent) => {
      // Asserted: frames on some other channel would be invisible to a count.
      expect(channel).toBe(RPC_STREAM_CHANNEL)
      streamed.push(frame)
    },
    once: (event: string, callback: () => void) => once.set(event, callback)
  }
  return {
    contents,
    streamed,
    navigate: () => once.get('did-start-loading')?.()
  }
}

const invoke = (contents: unknown, request: unknown): Promise<Response> =>
  handlers.get(RPC_CALL_CHANNEL)?.({ sender: contents }, request) as Promise<Response>

const release = (contents: unknown): void => {
  for (const listener of listeners.get(RPC_RELEASE_CHANNEL) ?? []) listener({ sender: contents })
}

describe('the ipc bridge, against a real registry', () => {
  let directory: string
  let hub: SubscriptionHub
  let context: ReturnType<typeof createRuntimeContext>
  let uninstall: () => void

  beforeEach(async () => {
    handlers.clear()
    listeners.clear()
    directory = await mkdtemp(join(tmpdir(), 'teamree-ipc-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    hub = new SubscriptionHub()
    context = createRuntimeContext({ version: '9.9.9', store, subscriptions: hub, endpoint: '/tmp/fake.sock' })
    const registry = new MethodRegistry(context)
    registerHandlers(registry)
    uninstall = installIpcBridge({ dispatch: createDispatcher(registry), subscriptions: hub })
  })

  afterEach(async () => {
    uninstall()
    hub.closeAll()
    await rm(directory, { recursive: true, force: true })
  })

  it('answers a request the renderer sends on the call channel', async () => {
    const window = fakeWindow(1)
    const response = await invoke(window.contents, { id: 'r1', method: 'status.get', params: {} })

    // The real dispatcher and handler: the id is correlated back.
    expect(response).toMatchObject({ id: 'r1', ok: true, result: { version: '9.9.9', endpoint: '/tmp/fake.sock' } })
  })

  it('stops dispatching once uninstalled, but still answers: a call made while quitting gets a frame, not a missing handler', async () => {
    const window = fakeWindow(1)
    uninstall()
    // Electron's own behaviour on a channel with no handler is to reject the page's
    // invoke with its wording; this is the frame the page gets instead.
    expect(handlers.has(RPC_CALL_CHANNEL)).toBe(true)
    const response = await invoke(window.contents, { id: 'late', method: 'status.get', params: {} })
    expect(response).toEqual({ id: 'late', ok: false, error: { code: 'internal', message: 'teamree is quitting.' } })
    // And the release listener really is gone, rather than merely replaced.
    expect(listeners.has(RPC_RELEASE_CHANNEL)).toBe(false)
    // A bridge installed afterwards takes the channel back without complaint.
    uninstall = installIpcBridge({ dispatch: createDispatcher(new MethodRegistry(context)), subscriptions: hub })
  })

  it('reports an unknown method rather than throwing across the bridge', async () => {
    const window = fakeWindow(1)
    const response = await invoke(window.contents, { id: 'r2', method: 'nope.nope', params: {} })
    expect(response).toMatchObject({ id: 'r2', ok: false, error: { code: 'unknown_method' } })
  })

  it('pushes a subscribed stream back on the stream channel', async () => {
    const window = fakeWindow(1)
    const response = await invoke(window.contents, { id: 'r3', method: 'workspace.subscribe', params: {} })
    expect(response.ok).toBe(true)
    const { subscription } = (response as { result: { subscription: string } }).result
    expect(hub.size).toBe(1)

    context.workspaceEvents.emit({ type: 'projects' })
    // Workspace events are coalesced before delivery, so this is waited for.
    await vi.waitFor(() => expect(window.streamed).toHaveLength(1))
    expect(window.streamed[0]).toEqual({ stream: subscription, event: { type: 'projects' } })
  })

  it('gives each window its own connection, so a reload drops only that window from the stream', async () => {
    const first = fakeWindow(1)
    const second = fakeWindow(2)
    await invoke(first.contents, { id: 'a', method: 'workspace.subscribe', params: {} })
    await invoke(second.contents, { id: 'b', method: 'workspace.subscribe', params: {} })
    expect(hub.size).toBe(2)

    // A reload: the page's stream goes and the other window's is untouched.
    first.navigate()
    expect(hub.size).toBe(1)

    context.workspaceEvents.emit({ type: 'projects' })
    await vi.waitFor(() => expect(second.streamed).toHaveLength(1))
    expect(first.streamed).toEqual([])
  })

  it('drops the subscriptions of a page that says on the release channel that it is unloading', async () => {
    const window = fakeWindow(1)
    await invoke(window.contents, { id: 'c', method: 'workspace.subscribe', params: {} })
    expect(hub.size).toBe(1)

    release(window.contents)
    expect(hub.size).toBe(0)
  })
})
