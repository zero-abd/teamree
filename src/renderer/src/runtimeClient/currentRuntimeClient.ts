// The single wiring point between the UI and the runtime transport.
//
// The transport's client is a structural superset of RuntimeClientContract
// (it adds `refresh()`), so no adapter is needed. Nothing else in the renderer
// imports a client directly, which is what keeps a transport swap to this file.
//
// `seededRuntimeClient` is retained deliberately: it implements the whole method
// catalogue in memory, so the UI can be developed and demoed in a plain browser
// with no Electron, no git, and no PTYs.

import type { RuntimeClient } from './RuntimeClientContract'
import { createRuntimeClient } from '../runtime'

export const runtimeClient: RuntimeClient = createRuntimeClient()

/** True while the UI is driven by seeded data; the status bar says so. */
export const RUNTIME_IS_SEEDED = false
