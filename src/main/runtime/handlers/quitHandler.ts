// Quitting the app from outside the window. A signal skips `before-quit`, where
// every pty is killed, the socket released and the scrollback written, so this asks
// for the quit key's quit. Deferred to a macrotask so the reply leaves before the connection goes.
// Refused while the window has edited files or agents are mid-turn, since nobody is at the window to
// answer its question; `force` quits anyway and the edits come back as drafts.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { conflict, notFound } from '../runtimeError'

export type QuitHandlerOptions = {
  /** Asks the app to quit; absent in every runtime with no app, where the method refuses. */
  requestQuit?: (force: boolean) => void
  /** The window's edited files. */
  unsavedFiles?: () => readonly string[]
  /** `2 agents are working`, or null when none is. */
  busyAgents?: () => string | null
  /** Defers the quit past the reply. Swappable for the tests, which cannot wait. */
  defer?: (run: () => void) => void
}

export function registerQuitHandler(registry: MethodRegistry, options: QuitHandlerOptions = {}): void {
  const defer = options.defer ?? ((run: () => void) => void setTimeout(run, 0))

  registry.register('app.quit', Params.appQuit, (params) => {
    const { requestQuit } = options
    if (requestQuit === undefined) {
      throw notFound('This runtime has no app to quit.')
    }
    const force = params.force === true
    const unsaved = force ? [] : (options.unsavedFiles?.() ?? [])
    if (unsaved.length > 0) {
      throw conflict(`Unsaved in the app: ${unsaved.join(', ')}. Save them, or pass --force to keep them as drafts.`, {
        unsaved
      })
    }
    const busy = force ? null : (options.busyAgents?.() ?? null)
    if (busy !== null) throw conflict(`${busy}. Pass --force to quit anyway.`)
    defer(() => requestQuit(force))
    return { quitting: true as const, pid: registry.context.pid }
  })
}
