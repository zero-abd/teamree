import { contextBridge, ipcRenderer } from 'electron'
import type { Response, StreamEvent } from '../shared/protocol'

// Channel names are spelled out rather than imported: preload belongs to both
// TypeScript projects, and importing from src/main would drag it into the
// renderer's compilation. Keep in step with src/main/runtime/ipcChannels.ts.
const RPC_CALL_CHANNEL = 'teamree:rpc:call'
const RPC_STREAM_CHANNEL = 'teamree:rpc:stream'
const RPC_RELEASE_CHANNEL = 'teamree:rpc:release'
// src/main/reveal/revealPath.ts
const REVEAL_PATH_CHANNEL = 'teamree:reveal-path'
// src/main/menuBar.ts; the command channel carries one string inward.
const MENU_PUBLISH_CHANNEL = 'teamree:menu:publish'
const MENU_COMMAND_CHANNEL = 'teamree:menu:command'
// src/main/agentNotices.ts
const NOTICE_PUBLISH_CHANNEL = 'teamree:notices:publish'
const NOTICE_REVEAL_CHANNEL = 'teamree:notices:reveal'
// src/main/keepAwake.ts; outward only.
const KEEP_AWAKE_PUBLISH_CHANNEL = 'teamree:keep-awake:publish'

/** What the main process answers a reveal with, declared structurally (not imported from src/main). */
type RevealResult = { revealed: true } | { revealed: false; reason: string }

/**
 * One item of the window's own menus, declared structurally for the same reason
 * `RevealResult` is; the renderer and main each hold their own copy.
 */
type MenuBarItem = {
  command: string
  label: string
  accelerator: string
  section: string
  enabled: boolean
}

/**
 * What the window tells the main process about notifications, and what comes
 * back. `preference` is a plain string: the main process parses it against its own list.
 */
type NoticeSettings = { preference: string; focusedPaneId: string | null }
type PaneAddress = { worktreeId: string; terminalId: string }

/** What the window says about sleep. `mode` is a plain string, parsed by the main process. */
type KeepAwakeState = { mode: string; agentBusy: boolean }

// The renderer never sees ipcRenderer; everything crossing the bridge is structured-cloneable.

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
  // Copied first: a listener may unsubscribe while the command is being delivered.
  for (const listener of [...menuCommandListeners]) listener(command)
})

/**
 * The application menu, which only the main process can install. `publish`
 * hands over the window's own menus; `onCommand` is how the choice comes back.
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

const revealListeners = new Set<(pane: PaneAddress) => void>()

ipcRenderer.on(NOTICE_REVEAL_CHANNEL, (_event, pane: PaneAddress) => {
  // Copied first, as above.
  for (const listener of [...revealListeners]) listener(pane)
})

/**
 * Notifications for an agent that stopped while nobody was looking. `publish`
 * hands over the window's facts; `onReveal` is a click coming back as one pane.
 */
const notices = {
  publish(settings: NoticeSettings): void {
    ipcRenderer.send(NOTICE_PUBLISH_CHANNEL, settings)
  },

  onReveal(listener: (pane: PaneAddress) => void): () => void {
    revealListeners.add(listener)
    return () => {
      revealListeners.delete(listener)
    }
  }
} as const

/**
 * Whether this Mac may sleep. Outward only; the assertion goes with the web
 * contents that published it, so the page cannot hold the machine awake after closing.
 */
const keepAwake = {
  publish(state: KeepAwakeState): void {
    ipcRenderer.send(KEEP_AWAKE_PUBLISH_CHANNEL, state)
  }
} as const

const api = {
  selectProjectFolder(): Promise<string | null> {
    return ipcRenderer.invoke('teamree:select-project-folder')
  },

  /**
   * Asks the OS file manager to show a path. A missing path comes back as
   * `{ revealed: false, reason }`: `showItemInFolder` on one is silent.
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
  menu,
  notices,
  keepAwake
} as const

export type TeamreeRuntimeBridge = typeof runtime
export type TeamreeApi = typeof api

contextBridge.exposeInMainWorld('teamree', api)
