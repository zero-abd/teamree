// How the window is painted. Goes through the runtime because the main process
// needs the answer before a window exists, to open it in the right colour.
// Not on the workspace change stream: the window that changed it already has it.

import { Params } from '../../../shared/methods'
import { sanitizeAppearance, type Appearance } from '../../../shared/theme'
import type { MethodRegistry } from '../methodRegistry'

/** `onChange` hears each stored appearance; the app points macOS's own appearance at it. */
export function registerAppearanceHandlers(
  registry: MethodRegistry,
  onChange: (appearance: Appearance) => void = () => {}
): void {
  registry.register('appearance.get', Params.appearanceGet, () => registry.context.store.getAppearance())

  // Sanitised on the way in as well as in the store, because the answer is what
  // the caller applies; a refused colour would otherwise be painted anyway.
  registry.register('appearance.set', Params.appearanceSet, (params) => {
    const stored = registry.context.store.setAppearance(sanitizeAppearance(params))
    onChange(stored)
    return stored
  })
}
