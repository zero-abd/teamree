import { contextBridge, ipcRenderer } from 'electron'
import type { Response, StreamEvent } from '../shared/protocol'

// Channel names are spelled out rather than imported: preload belongs to both
// TypeScript projects, and a module outside src/preload or src/shared would drag
// main-process files into the renderer's compilation. Keep these in step with
// src/main/runtime/ipcChannels.ts.
const RPC_CALL_CHANNEL = 'teamree:rpc:call'
const RPC_STREAM_CHANNEL = 'teamree:rpc:stream'
const RPC_RELEASE_CHANNEL = 'teamree:rpc:release'
// And this one with src/main/reveal/revealPath.ts, for the same reason.
const REVEAL_PATH_CHANNEL = 'teamree:reveal-path'
// And these two with src/main/menuBar.ts. The first carries the window's
// description of its own menus outward; the second is the only thing in this
// file that carries anything inward other than the RPC stream, and what it
// carries is one string — the `command` of a menu item this window itself
// published a moment earlier.
const MENU_PUBLISH_CHANNEL = 'teamree:menu:publish'
const MENU_COMMAND_CHANNEL = 'teamree:menu:command'

/**
 * What the main process answers a reveal with, declared structurally here.
 *
 * Not imported from src/main: preload is compiled into both TypeScript
 * projects, so a type taken from there would drag the whole main-process tree
 * into the renderer's. The shape is small and the main-process definition is
 * the one that has to stay in step with it.
 */
type RevealResult = { revealed: true } | { revealed: false; reason: string }

/**
 * One item of the window's own menus, declared structurally for the same reason
 * `RevealResult` is: the definition that matters belongs to the renderer
 * (`src/renderer/src/menu/menuBar.ts`) and the main process has a third copy it
 * parses incoming items against, because neither of those trees may be imported
 * from here. Plain strings and a boolean, so it crosses the bridge by value.
 */
type MenuBarItem = {
  command: string
  label: string
  accelerator: string
  section: string
  enabled: boolean
}

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

const menuCommandListeners = new Set<(command: string) => void>()

ipcRenderer.on(MENU_COMMAND_CHANNEL, (_event, command: string) => {
  // Copied first, for the same reason the stream listeners are: a listener may
  // unsubscribe while the command is being delivered.
  for (const listener of [...menuCommandListeners]) listener(command)
})

/**
 * The application menu, which only the main process can install.
 *
 * Two functions and nothing else. `publish` hands over a finished description
 * of teamree's own menus — labels, accelerators and which of them are live —
 * built in the window because that is where the command table and the state
 * that enables each command both are. `onCommand` is how the choice comes back.
 *
 * This grants the page nothing it did not already have: it can name the items
 * of a menu bar it is looking at, and it is told when one is chosen. Everything
 * a choice then does is done by the window's own code, through the same store
 * the chord goes through.
 */
const menu = {
  publish(items: readonly MenuBarItem[]): void {
    ipcRenderer.send(MENU_PUBLISH_CHANNEL, items)
  },

  onCommand(listener: (command: string) => void): () => void {
    menuCommandListeners.add(listener)
    return () => {
      menuCommandListeners.delete(listener)
    }
  }
} as const

const api = {
  selectProjectFolder(): Promise<string | null> {
    return ipcRenderer.invoke('teamree:select-project-folder')
  },

  /**
   * Asks the OS file manager to show a path — Finder on macOS, Explorer on
   * Windows, whatever the desktop uses on Linux.
   *
   * Never rejects for an ordinary failure. A path that has been deleted or
   * moved comes back as `{ revealed: false, reason }`, because the main process
   * checks before it asks the OS: `showItemInFolder` on a missing path is
   * silent, and a caller that could not tell has nothing to put on screen.
   */
  revealPath(path: string): Promise<RevealResult> {
    return ipcRenderer.invoke(REVEAL_PATH_CHANNEL, path)
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  runtime,
  menu
} as const

export type TeamreeRuntimeBridge = typeof runtime
export type TeamreeApi = typeof api

contextBridge.exposeInMainWorld('teamree', api)
