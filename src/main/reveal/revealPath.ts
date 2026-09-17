// Showing a path in the OS file manager, and refusing to when it would do
// nothing.
//
// This is not on the runtime RPC contract, and deliberately so: revealing a
// path is an action of the window the user is looking at, not a fact about the
// workspace. The CLI has no file manager to drive and a teammate across the
// relay must never be able to open a window on this machine, so this rides the
// plain Electron bridge beside `teamree:select-project-folder` instead of
// becoming a method every transport can reach.
//
// The reason there is a module here at all, rather than one line calling
// `shell.showItemInFolder`, is that the call is silent when it fails. Hand it a
// path that is not there and macOS does exactly nothing: no Finder window, no
// error, no return value to check. The case that hits is ordinary — a worktree
// whose checkout was deleted underneath the app, a repository dragged somewhere
// else between one launch and the next — and the user pressing "Reveal in
// Finder" on it deserves a sentence rather than a button that appears to be
// broken. So the existence check happens here, before the OS is asked, and
// every refusal comes back as a reason written for the person who pressed it.
//
// Nothing here imports electron. `showItemInFolder` is injected by the caller
// in src/main/index.ts, which keeps the whole of the decision testable in a
// plain vitest worker against a real temporary directory.

import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

// The channel name for the renderer transport. The preload script cannot import
// this module without pulling main-process files into the renderer's TypeScript
// project, so it repeats the same literal; change both together.
export const REVEAL_PATH_CHANNEL = 'teamree:reveal-path'

/**
 * What the renderer is told.
 *
 * A refusal is a value rather than a thrown error because the caller is a
 * button, and a button that was told why nothing happened can say so. Throwing
 * across the context bridge would reach the renderer as a message mangled by
 * Electron's serialisation, which is not something anybody can show a user.
 */
export type RevealResult = { revealed: true } | { revealed: false; reason: string }

export type RevealDeps = {
  /** The OS call. Injected so no test ever opens a real Finder window. */
  showItemInFolder: (path: string) => void
  /**
   * Whether anything is at that path. Defaults to `lstat`, which is the right
   * question here rather than `stat`: revealing shows the entry inside its
   * parent folder, and a symlink whose target has gone is still an entry the
   * file manager can select and the user can see for themselves.
   */
  exists?: (path: string) => Promise<boolean>
}

/**
 * Builds the reveal action over its injected dependencies.
 *
 * The parameter is `unknown` on purpose. It arrives over IPC from a renderer
 * that could have been navigated anywhere, so it is whatever the sender put on
 * the wire until this function has looked at it.
 */
export function createRevealPath(deps: RevealDeps): (path: unknown) => Promise<RevealResult> {
  const exists = deps.exists ?? entryExists

  return async (path: unknown): Promise<RevealResult> => {
    // Nothing that is not a full path reaches the OS. A relative path would be
    // resolved against this process's working directory, which is wherever the
    // app happened to be launched from and has nothing to do with the workspace
    // — so it would either reveal a stranger's folder or, far more likely,
    // reveal nothing and say nothing.
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

    // The check that this module exists for. See the note at the top: the OS
    // call is silent on a missing path, so a worktree whose checkout has been
    // deleted would otherwise be a button that does nothing at all.
    if (!(await exists(path))) {
      return {
        revealed: false,
        reason: `There is nothing at ${path} to show. It may have been deleted or moved since teamree last looked.`
      }
    }

    // A throw from the OS call is still the same question being answered — "did
    // the file manager come up?" — so it becomes a refusal carrying what went
    // wrong rather than an exception crossing the bridge. The path is named
    // because the reason is read next to a list of several of them.
    try {
      deps.showItemInFolder(path)
    } catch (error) {
      return { revealed: false, reason: `The file manager would not show ${path}: ${describe(error)}` }
    }
    return { revealed: true }
  }
}

/**
 * Just enough of Electron's invoke event for the caller's own sender check.
 *
 * Structural rather than imported, so this module stays free of electron and
 * so a test can hand the handler a two-field object.
 */
export type RevealInvokeEvent = { senderFrame: unknown; sender: { mainFrame: unknown } }

/** The one method of `ipcMain` this needs, named so a test can supply it. */
export type RevealIpc = {
  handle(channel: string, listener: (event: RevealInvokeEvent, path: unknown) => Promise<RevealResult>): void
}

export type RevealHandlerDeps = RevealDeps & {
  /**
   * Whether the frame that sent this invoke may drive the file manager. Left to
   * the caller because only the caller has Electron's event to compare against,
   * and absent it nothing is refused — which is right for a test handing in a
   * bare object, and is why src/main/index.ts always passes one.
   */
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
