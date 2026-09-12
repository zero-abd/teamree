// workspace.subscribe: one stream carrying every coarse invalidation the
// workspace produces, so a client stops polling and still sees work done through
// another transport.
//
// Like every other stream, the subscription belongs to the connection that asked
// for it, so a dropped socket or a reloaded renderer detaches its own listener
// and nothing accumulates over a long-lived runtime.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { createCoalescedStream } from '../workspaceEvents'

export function registerWorkspaceSubscribeHandler(registry: MethodRegistry): void {
  registry.register('workspace.subscribe', Params.workspaceSubscribe, (_params, call) => {
    const bus = registry.context.workspaceEvents
    const subscription = registry.context.subscriptions.subscribe(call.connectionId, (channel) => {
      // Per-subscriber coalescing: the window belongs to this stream alone.
      const stream = createCoalescedStream((event) => channel.emit(event))
      const unsubscribe = bus.on((event) => stream.push(event))
      return () => {
        unsubscribe()
        stream.cancel()
      }
    })
    return { subscription }
  })
}
