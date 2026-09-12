// unsubscribe is transport-level rather than feature-level: it belongs to the
// subscription hub, not to whatever produced the stream, so it works for every
// subscribing method past and future.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../methodRegistry'
import { notFound } from '../runtimeError'

export function registerUnsubscribeHandler(registry: MethodRegistry): void {
  registry.register('unsubscribe', Params.unsubscribe, (params, call) => {
    // Scoped to the calling connection so one client cannot cancel another's stream.
    const dropped = registry.context.subscriptions.unsubscribe(call.connectionId, params.subscription)
    if (!dropped) throw notFound(`unknown subscription: ${params.subscription}`)
    return { unsubscribed: true }
  })
}
