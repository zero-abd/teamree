// THE SEAM for teamwork's live half, registered like every other area. The
// `teamwork.*` methods are for whoever sits at this machine; `peer.presence`
// and `peer.subscribe` are for a teammate, per `PEER_METHODS` in `runtime/peerTransport.ts`.

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
  'peer.subscribe',
  'teamwork.shareNote',
  'teamwork.sharedNotes',
  'teamwork.viewNote',
  'teamwork.closeNote',
  'peer.shareNote'
] as const

export function registerPeerHandlers(registry: MethodRegistry, service: PeerService): PeerService {
  // Asked before answering: the project key hashes the `origin` remote and
  // nothing watches git's config. A `stat` per call, a git subprocess only when it moved.
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

  // Resolved first, subscribed second: the answer carries the owner's
  // dimensions with the subscription id, or a watcher draws one frame at the wrong size.
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

  registry.register('teamwork.shareNote', Params.teamworkShareNote, (params) => service.shareNote(params))
  registry.register('teamwork.sharedNotes', Params.teamworkSharedNotes, () => service.sharedNotes())
  registry.register('teamwork.viewNote', Params.teamworkViewNote, (params) => service.viewNote(params))
  registry.register('teamwork.closeNote', Params.teamworkCloseNote, (params) => service.closeNote(params))
  registry.register('peer.shareNote', Params.peerShareNote, (params, call) =>
    service.receiveNote(call.connectionId, params)
  )

  return service
}
