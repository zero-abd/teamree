// THE SEAM for teamwork's live half, registered exactly like every other area.
//
// Six methods and a strict split between them. `teamwork.status`,
// `teamwork.presence`, `teamwork.watch` and `teamwork.watchers` are for whoever
// is sitting at this machine: the window asks them over IPC, the CLI over its
// socket. `peer.presence` and `peer.subscribe` are for a teammate, and are
// reachable only over the peer transport, because `PEER_METHODS` in
// `runtime/peerTransport.ts` is the list of what a teammate may call and those
// two are on it while `worktree.remove` is not.
//
// `teamwork.watch` is on the local side of that line and belongs there. It is
// this machine asking to read somebody else's pane, and what crosses the wire
// under it is `terminal.subscribe` and `terminal.read` — two methods the
// teammate's own allow-list admits, answered by their own terminal service,
// which has no idea any of this exists.
//
// They are registered here together anyway, in the one registry, because that
// is the whole architectural claim: a teammate is another transport onto the
// catalogue that already exists, not a catalogue of its own. The allow-list is
// what makes the two audiences different, and keeping it in one place — beside
// the transport that enforces it — is what stops the difference being spread
// across every handler.

import { Params } from '../../../shared/methods'
import type { ParamsOf, ResultOf } from '../../../shared/methods'
import type { MethodRegistry } from '../../runtime/methodRegistry'
import type { PeerService } from './peerService'

export const PEER_SERVICE_METHODS = [
  'teamwork.status',
  'teamwork.presence',
  'teamwork.watch',
  'teamwork.watchers',
  'peer.presence',
  'peer.subscribe'
] as const

export type PeerServiceMethodName = (typeof PEER_SERVICE_METHODS)[number]

export type PeerServiceHandlers = {
  'teamwork.status': (params: ParamsOf<'teamwork.status'>) => ResultOf<'teamwork.status'>
  'teamwork.presence': (params: ParamsOf<'teamwork.presence'>) => ResultOf<'teamwork.presence'>
  'teamwork.watchers': (params: ParamsOf<'teamwork.watchers'>) => ResultOf<'teamwork.watchers'>
}

export function registerPeerHandlers(registry: MethodRegistry, service: PeerService): PeerService {
  registry.register('teamwork.status', Params.teamworkStatus, (params) => service.status(params))
  registry.register('teamwork.presence', Params.teamworkPresence, (params) => service.presence(params))
  registry.register('teamwork.watchers', Params.teamworkWatchers, (params) => service.watchers(params))

  // Resolved first, subscribed second, and in that order because the answer has
  // to carry the owner's dimensions alongside the subscription id: a watcher
  // that received the id and then asked how big the pane is would draw one
  // frame at the wrong size before it found out.
  registry.register('teamwork.watch', Params.teamworkWatch, (params, call) => {
    const opened = service.openWatch(params)
    return {
      subscription: registry.context.subscriptions.subscribe(call.connectionId, (channel) => opened.start(channel)),
      cols: opened.cols,
      rows: opened.rows,
      handle: opened.handle
    }
  })

  registry.register('peer.presence', Params.peerPresence, (_params, call) => service.peerPresence(call.connectionId))
  registry.register('peer.subscribe', Params.peerSubscribe, (_params, call) => ({
    subscription: registry.context.subscriptions.subscribe(call.connectionId, (channel) =>
      service.peerSubscribe(call.connectionId, channel)
    )
  }))

  return service
}
