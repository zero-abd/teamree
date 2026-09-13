// Encrypted peer sessions, as a pure library: bytes in, bytes out.
//
// It knows nothing about sockets, the relay, Electron or React, and imports
// nothing from `src/main` or `src/renderer`, so the whole of it can be tested in
// memory. Milestone B in `docs/teamwork.md` is what wires it to a connection.
//
// `noise.ts` and `primitives.ts` are deliberately not re-exported. They are the
// specification's machinery and the tests reach into them directly, but a caller
// with a raw `CipherState` in hand can reuse a nonce, and nothing outside this
// directory has a reason to hold one.

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
