// Quitting the app from outside the window.
//
// Until this existed the only way to end a running teamree from a script was a
// signal, and a signal is the one ending this app must not be given: `app.quit`
// runs `before-quit`, and `before-quit` is where every pty is killed and awaited,
// the socket and the discovery file released, and the scrollback written. So the
// method asks for exactly the quit the quit key asks for, and nothing here knows
// any more about shutting down than that.
//
// The reply goes out before the quit is asked for, because the quit takes the
// connection the reply would have travelled on. the quit is therefore deferred to
// a macrotask: the dispatcher's response is written when this handler's promise
// settles, which is a microtask away, and a timer fires after every one of those.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { notFound } from '../runtimeError'

export type QuitHandlerOptions = {
  /**
   * Asks the app to quit — `app.quit` in the main process, which is the only
   * caller that has one.
   *
   * Absent in every runtime with no app around it, where the method then
   * refuses. Passed in rather than imported for the reason `openExternal` is:
   * the code that can end this process is the code that was handed the means.
   */
  requestQuit?: () => void
  /** Defers the quit past the reply. Swappable for the tests, which cannot wait. */
  defer?: (run: () => void) => void
}

export function registerQuitHandler(registry: MethodRegistry, options: QuitHandlerOptions = {}): void {
  const defer = options.defer ?? ((run: () => void) => void setTimeout(run, 0))

  registry.register('app.quit', Params.appQuit, () => {
    const { requestQuit } = options
    if (requestQuit === undefined) {
      throw notFound('This runtime has no app to quit.')
    }
    defer(requestQuit)
    return { quitting: true as const, pid: registry.context.pid }
  })
}
