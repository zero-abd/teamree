// The single wiring point between the UI and the runtime transport.
//
// To go live, swap the two lines below for:
//
//   import { createRuntimeClient } from '../runtime'
//   export const runtimeClient: RuntimeClient = createRuntimeClient()
//   export const RUNTIME_IS_SEEDED = false
//
// The transport's client is a structural superset of RuntimeClientContract
// (it adds `refresh()`), so no adapter is needed. Nothing else in the renderer
// imports a client directly, which is what keeps the change to this file.

import type { RuntimeClient } from './RuntimeClientContract'
import { createSeededRuntimeClient } from './seededRuntimeClient'

export const runtimeClient: RuntimeClient = createSeededRuntimeClient()

/** True while the UI is driven by seeded data; the status bar says so. */
export const RUNTIME_IS_SEEDED = true
