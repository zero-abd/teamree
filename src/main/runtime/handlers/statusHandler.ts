// status.get is the runtime's liveness probe: the CLI calls it to confirm the
// endpoint it found in the discovery file belongs to a runtime that is actually
// answering, and the GUI uses it to show what it is connected to.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'

export function registerStatusHandler(registry: MethodRegistry): void {
  registry.register('status.get', Params.statusGet, () => ({
    version: registry.context.version,
    endpoint: registry.context.endpoint,
    pid: registry.context.pid,
    platform: registry.context.platform,
    startedAt: registry.context.startedAt
  }))
}
