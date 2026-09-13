// How the window is painted, read and written like any other durable state.
//
// It goes through the runtime rather than through the renderer's own storage
// for the same reason the workspace does: the main process needs the answer
// before a window exists, to open that window in the colour it is about to
// paint itself, and a second window has to open the colour the first one is.
// Browser storage is per-renderer and invisible to both.
//
// Deliberately not on the workspace change stream. Everything on that stream is
// a collection a client re-reads; this is one small record the window that
// changed it already has in hand, and the only reader that could be stale is a
// second window, which is not a thing this app opens.

import { Params } from '../../../shared/methods'
import { sanitizeAppearance } from '../../../shared/theme'
import type { MethodRegistry } from '../methodRegistry'

export function registerAppearanceHandlers(registry: MethodRegistry): void {
  registry.register('appearance.get', Params.appearanceGet, () => registry.context.store.getAppearance())

  // Sanitised on the way in as well as in the store, because the answer is what
  // the caller applies: a renderer that sent a colour this runtime refused
  // would otherwise paint it anyway and disagree with the file on disk.
  registry.register('appearance.set', Params.appearanceSet, (params) =>
    registry.context.store.setAppearance(sanitizeAppearance(params))
  )
}
