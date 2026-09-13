// THE SEAM for teamwork's live half, registered exactly like every other area.
//
// Four methods and a strict split between them. `teamwork.status` and
// `teamwork.presence` are for whoever is sitting at this machine: the window
// asks them over IPC, the CLI over its socket. `peer.presence` and
// `peer.subscribe` are for a teammate, and are reachable only over the peer
// transport, because `PEER_METHODS` in `runtime/peerTransport.ts` is the list
// of what a teammate may call and those two are on it while `worktree.remove`
// is not.
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

export const PEER_SERVICE_METHODS = ['teamwork.status', 'teamwork.presence', 'peer.presence', 'peer.subscribe'] as const

export type PeerServiceMethodName = (typeof PEER_SERVICE_METHODS)[number]

export type PeerServiceHandlers = {
  'teamwork.status': (params: ParamsOf<'teamwork.status'>) => ResultOf<'teamwork.status'>
  'teamwork.presence': (params: ParamsOf<'teamwork.presence'>) => ResultOf<'teamwork.presence'>
}

export function registerPeerHandlers(registry: MethodRegistry, service: PeerService): PeerService {
  registry.register('teamwork.status', Params.teamworkStatus, (params) => service.status(params))
  registry.register('teamwork.presence', Params.teamworkPresence, (params) => service.presence(params))

  registry.register('peer.presence', Params.peerPresence, (_params, call) => service.peerPresence(call.connectionId))
  registry.register('peer.subscribe', Params.peerSubscribe, (_params, call) => ({
    subscription: registry.context.subscriptions.subscribe(call.connectionId, (channel) =>
      service.peerSubscribe(call.connectionId, channel)
    )
  }))

  return service
}
