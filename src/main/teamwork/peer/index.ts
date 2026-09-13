// Public face of the peer transport. The runtime imports from here.

export { createPeerLink, BACKOFF_CEILING_MS, BACKOFF_START_MS, HANDSHAKE_TIMEOUT_MS, KEEPALIVE_MS } from './peerLink'
export type { LinkScheduler, PeerLink, PeerLinkOptions } from './peerLink'
export { PEER_SERVICE_METHODS, registerPeerHandlers } from './handlers'
export { PeerService, PRESENCE_COALESCE_MS } from './peerService'
export type { PeerServiceOptions, PeerWorkspace } from './peerService'
export { presenceFor } from './presence'
export type { PresenceProject, PresenceSource } from './presence'
export { normaliseRemote, projectKeyFor, readProjectKey } from './projectKey'
export {
  openRelayConnection,
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  reconnectPolicyFor,
  type RelayClosure,
  type RelayConnection
} from './relayConnection'
export {
  NO_CLOSE_CODE,
  webSocketDialer,
  type RelayDialer,
  type RelaySocket,
  type RelaySocketHandlers
} from './relaySocket'
export {
  RELAY_FILE_NAME,
  RELAY_FILE_SEGMENTS,
  RELAY_URL_ENV,
  parseRelayUrl,
  readRelayConfig,
  relayFileTemplate,
  type RelayConfig,
  type RelayLocation
} from './relayUrl'
export {
  EPOCH_SECONDS,
  RENDEZVOUS_SALT,
  epochAt,
  epochEndsAt,
  rendezvousId,
  rendezvousToken,
  rendezvousUrl,
  sharedSecret
} from './rendezvous'
