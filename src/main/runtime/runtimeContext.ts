// Process-wide dependencies every handler may reach for. Kept separate from the
// per-call context so a handler cannot accidentally capture one connection's
// identity in long-lived state.

import type { SubscriptionHub } from './subscriptionHub'
import { WorkspaceEventBus } from './workspaceEvents'
import type { WorkspaceStore } from '../store/workspaceStore'

export type RuntimeContext = {
  readonly version: string
  readonly startedAt: number
  readonly pid: number
  readonly platform: NodeJS.Platform
  readonly store: WorkspaceStore
  readonly subscriptions: SubscriptionHub
  /** Where every producer publishes workspace changes and subscribers read them. */
  readonly workspaceEvents: WorkspaceEventBus
  /**
   * Socket path or named pipe. Empty until the socket server binds, and it can
   * stay empty when the runtime is embedded with no CLI endpoint.
   */
  endpoint: string
}

export type RuntimeContextInit = {
  version: string
  store: WorkspaceStore
  subscriptions: SubscriptionHub
  /** Defaulted, so a harness that only needs a dispatcher can leave it out. */
  workspaceEvents?: WorkspaceEventBus
  endpoint?: string
}

export function createRuntimeContext(init: RuntimeContextInit): RuntimeContext {
  return {
    version: init.version,
    startedAt: Date.now(),
    pid: process.pid,
    platform: process.platform,
    store: init.store,
    subscriptions: init.subscriptions,
    workspaceEvents: init.workspaceEvents ?? new WorkspaceEventBus(),
    endpoint: init.endpoint ?? ''
  }
}
