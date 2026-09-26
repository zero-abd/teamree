import { homedir } from 'node:os'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Response, StreamEvent } from '../shared/protocol'

// Channel names are spelled out rather than imported: preload belongs to both
// TypeScript projects, and importing from src/main would drag it into the
// renderer's compilation. Keep in step with src/main/runtime/ipcChannels.ts.
const RPC_CALL_CHANNEL = 'teamree:rpc:call'
const RPC_STREAM_CHANNEL = 'teamree:rpc:stream'
const RPC_RELEASE_CHANNEL = 'teamree:rpc:release'
// src/main/reveal/revealPath.ts
const REVEAL_PATH_CHANNEL = 'teamree:reveal-path'
const OPEN_PATH_CHANNEL = 'teamree:open-path'
// src/main/menuBar.ts; the command channel carries one string inward.
const MENU_PUBLISH_CHANNEL = 'teamree:menu:publish'
const MENU_COMMAND_CHANNEL = 'teamree:menu:command'
// src/main/agentNotices.ts
const NOTICE_PUBLISH_CHANNEL = 'teamree:notices:publish'
const NOTICE_REVEAL_CHANNEL = 'teamree:notices:reveal'
// src/main/keepAwake.ts; outward only.
const KEEP_AWAKE_PUBLISH_CHANNEL = 'teamree:keep-awake:publish'
// src/main/unsavedFiles.ts
const UNSAVED_PUBLISH_CHANNEL = 'teamree:unsaved:publish'
const UNSAVED_ASK_CHANNEL = 'teamree:unsaved:ask'
const UNSAVED_ANSWER_CHANNEL = 'teamree:unsaved:answer'
// src/main/invitationLinks.ts; a link inward, pulled once and then pushed.
const INVITATION_TAKE_CHANNEL = 'teamree:invitation:take'
const INVITATION_OPEN_CHANNEL = 'teamree:invitation:open'
// src/main/menuBarExtra/quickNoteWindow.ts
const QUICK_NOTE_CONTEXT_CHANNEL = 'teamree:quick-note:context'
const QUICK_NOTE_SAVE_CHANNEL = 'teamree:quick-note:save'
const QUICK_NOTE_CLOSE_CHANNEL = 'teamree:quick-note:close'

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
type NoticeSettings = {
  preference: string
  focusedPaneId: string | null
  names: Record<string, string>
  activeWorktreeId: string | null
}
type PaneAddress = { worktreeId: string; terminalId: string }

/** What the Quick Note panel is offered, and what it sends back; see src/main/menuBarExtra/quickNote.ts. */
type QuickNoteContext = {
  projects: { id: string; name: string }[]
  projectId: string | null
  worktree: { id: string; name: string; projectId: string } | null
}
type QuickNote = { projectId: string; worktreeId: string | null; text: string }
type QuickNoteSaved = { saved: string } | { problem: string }

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

type LeaveReason = 'quit' | 'close'

let answerLeave: ((reason: LeaveReason) => Promise<boolean>) | null = null

// No listener means nothing edited to ask about; a failed answer keeps the window.
ipcRenderer.on(UNSAVED_ASK_CHANNEL, (_event, question: { id: number; reason: LeaveReason }) => {
  const reply = (proceed: boolean): void => ipcRenderer.send(UNSAVED_ANSWER_CHANNEL, { id: question.id, proceed })
  void (answerLeave?.(question.reason) ?? Promise.resolve(true)).then(reply, () => reply(false))
})

/** Edited file paths, outward; the main process's question before a quit or close, inward. */
const unsaved = {
  publish(paths: readonly string[]): void {
    ipcRenderer.send(UNSAVED_PUBLISH_CHANNEL, paths)
  },

  onAsk(listener: (reason: LeaveReason) => Promise<boolean>): () => void {
    answerLeave = listener
    return () => {
      if (answerLeave === listener) answerLeave = null
    }
  }
} as const

const invitationListeners = new Set<(link: string) => void>()

ipcRenderer.on(INVITATION_OPEN_CHANNEL, (_event, link: string) => {
  for (const listener of [...invitationListeners]) listener(link)
})

/** `teamree://join?…` links the OS opened the app with. `take` answers the one that arrived before the window. */
const invitations = {
  take(): Promise<string | null> {
    return ipcRenderer.invoke(INVITATION_TAKE_CHANNEL)
  },

  onLink(listener: (link: string) => void): () => void {
    invitationListeners.add(listener)
    return () => {
      invitationListeners.delete(listener)
    }
  }
} as const

/** The Quick Note panel's end; the main process answers only that panel. */
const quickNote = {
  context(): Promise<QuickNoteContext> {
    return ipcRenderer.invoke(QUICK_NOTE_CONTEXT_CHANNEL)
  },
  save(note: QuickNote): Promise<QuickNoteSaved> {
    return ipcRenderer.invoke(QUICK_NOTE_SAVE_CHANNEL, note)
  },
  close(): void {
    ipcRenderer.send(QUICK_NOTE_CLOSE_CHANNEL)
  }
} as const

const api = {
  selectProjectFolder(): Promise<string | null> {
    return ipcRenderer.invoke('teamree:select-project-folder')
  },
  /** A folder to put something in, starting at `defaultPath`; null when cancelled. */
  chooseFolder(defaultPath: string): Promise<string | null> {
    return ipcRenderer.invoke('teamree:choose-folder', defaultPath)
  },
  /** This user's home folder, so a `~` path can be shown as the runtime will resolve it. */
  homeDir: homedir(),
  /** Where a dropped file or folder is on disk; empty for one that is not on disk. */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },

  /**
   * Asks the OS file manager to show a path. A missing path comes back as
   * `{ revealed: false, reason }`: `showItemInFolder` on one is silent.
   */
  revealPath(path: string): Promise<RevealResult> {
    return ipcRenderer.invoke(REVEAL_PATH_CHANNEL, path)
  },
  /** Opens a file in the app the OS picks for it; refuses executables. */
  openPath(path: string): Promise<RevealResult> {
    return ipcRenderer.invoke(OPEN_PATH_CHANNEL, path)
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
  keepAwake,
  unsaved,
  invitations,
  quickNote
} as const

export type TeamreeRuntimeBridge = typeof runtime
export type TeamreeApi = typeof api

contextBridge.exposeInMainWorld('teamree', api)
