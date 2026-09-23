// THE SEAM for teamwork's live half, registered exactly like every other area.
//
// Twelve methods and a strict split between them. `teamwork.status`,
// `teamwork.presence`, `teamwork.watch`, `teamwork.type`, `teamwork.watchers`,
// `teamwork.mute`, `teamwork.requests`, `teamwork.decide`, `teamwork.revoke`
// and `teamwork.writeLog` are for whoever is sitting at this machine: the
// window asks them over IPC, the CLI over its socket.
// `peer.presence` and `peer.subscribe` are for a teammate, and are reachable
// only over the peer transport, because `PEER_METHODS` in
// `runtime/peerTransport.ts` is the list of what a teammate may call and those
// two are on it while `worktree.remove` is not.
//
// `teamwork.watch` and `teamwork.type` are on the local side of that line and
// belong there. They are this machine asking to read and to type into somebody
// else's pane, and what crosses the wire under them is `terminal.subscribe`,
// `terminal.read` and `terminal.write` — three methods the teammate's own
// allow-list admits, answered by their own terminal service, which has no idea
// any of this exists.
//
// `teamwork.mute`, `teamwork.requests`, `teamwork.decide`, `teamwork.revoke`
// and `teamwork.writeLog` never cross a wire at all. All five are the owner's
// side of the bargain in `docs/teamwork.md`: what may reach my panes, what is
// waiting to, and what has. A mute that had to be agreed with anybody would not
// be a mute, and neither would a permission — which is why answering one is a
// method a teammate cannot call even to ask about their own held keystrokes.
//
// They are registered here together anyway, in the one registry, because that
// is the whole architectural claim: a teammate is another transport onto the
// catalogue that already exists, not a catalogue of its own. The allow-list is
// what makes the two audiences different, and keeping it in one place — beside
// the transport that enforces it — is what stops the difference being spread
// across every handler.

import { Params } from '../../../shared/methods'
import type { MethodRegistry } from '../../runtime/methodRegistry'
import type { PeerService } from './peerService'

export const PEER_SERVICE_METHODS = [
  'teamwork.status',
  'teamwork.presence',
  'teamwork.watch',
  'teamwork.type',
  'teamwork.watchers',
  'teamwork.mute',
  'teamwork.requests',
  'teamwork.decide',
  'teamwork.revoke',
  'teamwork.writeLog',
  'peer.presence',
  'peer.subscribe'
] as const

export function registerPeerHandlers(registry: MethodRegistry, service: PeerService): PeerService {
  // Asked before answering, because the project key is a hash of the `origin`
  // remote and git's config is the one input behind this answer that no watch
  // in this app covers. Without it a user who fixes their remote goes on being
  // told to fix it. It costs a `stat` per call and a git subprocess only when
  // that `stat` moved.
  registry.register('teamwork.status', Params.teamworkStatus, async (params) => {
    await service.refreshIfOriginMoved(params.projectId)
    return service.status(params)
  })
  registry.register('teamwork.presence', Params.teamworkPresence, (params) => service.presence(params))
  registry.register('teamwork.watchers', Params.teamworkWatchers, (params) => service.watchers(params))
  registry.register('teamwork.type', Params.teamworkType, (params) => service.type(params))
  registry.register('teamwork.mute', Params.teamworkMute, (params) => service.mute(params))
  registry.register('teamwork.requests', Params.teamworkRequests, (params) => service.requests(params))
  registry.register('teamwork.decide', Params.teamworkDecide, (params) => service.decide(params))
  registry.register('teamwork.revoke', Params.teamworkRevoke, (params) => service.revoke(params))
  registry.register('teamwork.writeLog', Params.teamworkWriteLog, (params) => service.writeLog(params))

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
