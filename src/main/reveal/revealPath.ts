// Showing a path in the OS file manager. Not on the runtime contract: a
// teammate across the relay must never open a window here. A module because
// `shell.showItemInFolder` on a missing path does nothing and says nothing.

import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

// The preload repeats this literal; change both together.
export const REVEAL_PATH_CHANNEL = 'teamree:reveal-path'

/** What the renderer is told. A value, not a throw: Electron mangles errors across the bridge. */
export type RevealResult = { revealed: true } | { revealed: false; reason: string }

export type RevealDeps = {
  /** The OS call. Injected so no test ever opens a real Finder window. */
  showItemInFolder: (path: string) => void
  /** Whether anything is at that path. `lstat`, not `stat`: a dangling symlink is still an entry to show. */
  exists?: (path: string) => Promise<boolean>
}

/** Builds the reveal action. The parameter is `unknown`: it arrives over IPC. */
export function createRevealPath(deps: RevealDeps): (path: unknown) => Promise<RevealResult> {
  const exists = deps.exists ?? entryExists

  return async (path: unknown): Promise<RevealResult> => {
    // A relative path would resolve against wherever the app was launched from.
    if (typeof path !== 'string' || path.length === 0) {
      return {
        revealed: false,
        reason: 'teamree was asked to show a path in the file manager without being given one.'
      }
    }
    if (!isAbsolute(path)) {
      return {
        revealed: false,
        reason: `teamree can only show a full path in the file manager, and ${path} is a relative one.`
      }
    }

    // The OS call is silent on a missing path.
    if (!(await exists(path))) {
      return {
        revealed: false,
        reason: `There is nothing at ${path} to show. It may have been deleted or moved since teamree last looked.`
      }
    }

    // A throw becomes a refusal rather than an exception crossing the bridge.
    try {
      deps.showItemInFolder(path)
    } catch (error) {
      return { revealed: false, reason: `The file manager would not show ${path}: ${describe(error)}` }
    }
    return { revealed: true }
  }
}

/** Just enough of Electron's invoke event for the sender check; structural, so tests need no electron. */
export type RevealInvokeEvent = { senderFrame: unknown; sender: { mainFrame: unknown } }

/** The one method of `ipcMain` this needs, named so a test can supply it. */
export type RevealIpc = {
  handle(channel: string, listener: (event: RevealInvokeEvent, path: unknown) => Promise<RevealResult>): void
}

export type RevealHandlerDeps = RevealDeps & {
  /** Whether the sending frame may drive the file manager; absent, nothing is refused. */
  fromMainFrame?: (event: RevealInvokeEvent) => boolean
}

/** Puts the reveal action on `teamree:reveal-path`. */
export function registerRevealHandler(ipc: RevealIpc, deps: RevealHandlerDeps): void {
  const reveal = createRevealPath(deps)
  ipc.handle(REVEAL_PATH_CHANNEL, async (event, path) => {
    if (deps.fromMainFrame !== undefined && !deps.fromMainFrame(event)) {
      return { revealed: false, reason: 'teamree only shows a path in the file manager when the window itself asks.' }
    }
    return reveal(path)
  })
}

async function entryExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
