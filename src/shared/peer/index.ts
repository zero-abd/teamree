// Encrypted peer sessions as a pure library: bytes in, bytes out, nothing from
// `src/main` or `src/renderer`. `noise.ts` and `primitives.ts` are not
// re-exported: a caller holding a raw `CipherState` can reuse a nonce.

export {
  createInitiatorSession,
  createResponderSession,
  generateStaticKeyPair,
  MAX_PLAINTEXT_LEN,
  PROTOCOL_NAME,
  rosterOf,
  type InitiatorOptions,
  type PeerRole,
  type PeerSession,
  type ResponderOptions,
  type SessionStage
} from './session'

export { isPeerError, PeerError, PeerErrorCode } from './errors'

export { DH_LEN, type KeyPair, type RandomSource, derivePublicKey } from './primitives'
