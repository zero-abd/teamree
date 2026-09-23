// "Open in default app" for a file pane. A window action like reveal, so it is on
// the Electron bridge and never on the runtime contract a teammate can reach.

import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RevealInvokeEvent, RevealResult } from './revealPath'

// Repeated as a literal in src/preload/index.ts; change both together.
export const OPEN_PATH_CHANNEL = 'teamree:open-path'

export type OpenPathDeps = {
  /** `shell.openPath`: resolves to an error message, or '' once the file is open. */
  openPath: (path: string) => Promise<string>
  fromMainFrame?: (event: RevealInvokeEvent) => boolean
}

export function createOpenPath(deps: Pick<OpenPathDeps, 'openPath'>): (path: unknown) => Promise<RevealResult> {
  return async (path) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return { revealed: false, reason: 'not a full path' }
    const info = await stat(path).catch(() => null)
    if (info === null) return { revealed: false, reason: `nothing at ${path}` }
    if (!info.isFile()) return { revealed: false, reason: `${path} is not a file` }
    // The default app for an executable is running it.
    if ((info.mode & 0o111) !== 0) return { revealed: false, reason: `${path} is executable` }
    const failure = await deps.openPath(path).catch((error: unknown) => String(error))
    return failure === '' ? { revealed: true } : { revealed: false, reason: failure }
  }
}

export function registerOpenPathHandler(
  ipc: { handle(channel: string, listener: (event: RevealInvokeEvent, path: unknown) => Promise<RevealResult>): void },
  deps: OpenPathDeps
): void {
  const open = createOpenPath(deps)
  ipc.handle(OPEN_PATH_CHANNEL, async (event, path) => {
    if (deps.fromMainFrame !== undefined && !deps.fromMainFrame(event))
      return { revealed: false, reason: 'not the window' }
    return open(path)
  })
}
