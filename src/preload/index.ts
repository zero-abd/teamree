import { contextBridge, ipcRenderer } from 'electron'
import type { Response, StreamEvent } from '../shared/protocol'

// Channel names are spelled out rather than imported: preload belongs to both
// TypeScript projects, and a module outside src/preload or src/shared would drag
// main-process files into the renderer's compilation. Keep these in step with
// src/main/runtime/ipcChannels.ts.
const RPC_CALL_CHANNEL = 'teamree:rpc:call'
const RPC_STREAM_CHANNEL = 'teamree:rpc:stream'
const RPC_RELEASE_CHANNEL = 'teamree:rpc:release'

// The renderer never sees ipcRenderer: it gets three plain functions over the
// context bridge. Everything crossing the bridge is structured-cloneable, so the
// renderer cannot reach a live main-process object through them.

const streamListeners = new Set<(frame: StreamEvent) => void>()

ipcRenderer.on(RPC_STREAM_CHANNEL, (_event, frame: StreamEvent) => {
  // Copied first: a listener may unsubscribe while the frame is being delivered.
  for (const listener of [...streamListeners]) listener(frame)
})

let requestCounter = 0

const runtime = {
  /** Sends one request and resolves with the raw protocol response frame. */
  call(method: string, params: unknown): Promise<Response> {
    requestCounter += 1
    const id = `r${requestCounter}`
    return ipcRenderer.invoke(RPC_CALL_CHANNEL, { id, method, params }) as Promise<Response>
  },

  onStream(listener: (frame: StreamEvent) => void): () => void {
    streamListeners.add(listener)
    return () => {
      streamListeners.delete(listener)
    }
  },

  /** Drops this page's subscriptions ahead of an unload the main process cannot see. */
  release(): void {
    ipcRenderer.send(RPC_RELEASE_CHANNEL)
  }
} as const

const api = {
  selectProjectFolder(): Promise<string | null> {
    return ipcRenderer.invoke('teamree:select-project-folder')
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  runtime
} as const

export type TeamreeRuntimeBridge = typeof runtime
export type TeamreeApi = typeof api

contextBridge.exposeInMainWorld('teamree', api)
