// The one error type this library throws, and the reason its message is not a
// parameter.
//
// Every other error type in this codebase takes a free-form message. This one
// does not: the caller picks a code and the text comes from a frozen table.
// That is deliberate. Handshake and transport code holds private keys, chaining
// keys and nonces in the same scope as its throw sites, so a message parameter
// is one careless template literal away from putting key material into a log
// line, a crash report, or a `JSON.stringify` of the error. Removing the
// parameter removes the possibility instead of relying on review to catch it.
//
// The code is the context. If a failure needs more than the code to diagnose,
// add a code.

export const PeerErrorCode = {
  /** A key or message was the wrong length, or a public key was not a usable X25519 point. */
  InvalidKey: 'invalid_key',
  /** A method was called at a point in the session's life where it has no meaning. */
  OutOfTurn: 'out_of_turn',
  /** The session failed earlier and refuses to do anything further. */
  SessionClosed: 'session_closed',
  /** A wire message was shorter than the handshake tokens it must carry. */
  Truncated: 'truncated',
  /** A wire message exceeded the 65535-byte Noise limit. */
  MessageTooLong: 'message_too_long',
  /** AEAD authentication failed: forged, tampered, replayed or reordered. */
  DecryptionFailed: 'decryption_failed',
  /** The peer's static key is not on the roster we were given. */
  UnknownPeer: 'unknown_peer',
  /** The 2^64 - 1 nonce ceiling was reached. The session must be rebuilt, never wrapped. */
  NonceExhausted: 'nonce_exhausted'
} as const

export type PeerErrorCode = (typeof PeerErrorCode)[keyof typeof PeerErrorCode]

/**
 * Fixed, secret-free text per code. Frozen so nothing can edit an entry at
 * runtime to smuggle a value in through the back door.
 */
const MESSAGES: Readonly<Record<PeerErrorCode, string>> = Object.freeze({
  [PeerErrorCode.InvalidKey]: 'key material was not a usable X25519 key of the expected length',
  [PeerErrorCode.OutOfTurn]: 'the session is not at a point where this call means anything',
  [PeerErrorCode.SessionClosed]: 'the session is closed and cannot be used again',
  [PeerErrorCode.Truncated]: 'the message is shorter than the handshake pattern requires',
  [PeerErrorCode.MessageTooLong]: 'the message exceeds the 65535-byte Noise limit',
  [PeerErrorCode.DecryptionFailed]: 'authentication failed; the message was not produced by this session',
  [PeerErrorCode.UnknownPeer]: 'the peer static key is not on the roster',
  [PeerErrorCode.NonceExhausted]: 'the nonce space for this session is exhausted'
})

export class PeerError extends Error {
  readonly code: PeerErrorCode

  constructor(code: PeerErrorCode) {
    super(MESSAGES[code])
    this.name = 'PeerError'
    this.code = code
  }
}

export function peerError(code: PeerErrorCode): PeerError {
  return new PeerError(code)
}

export function isPeerError(value: unknown): value is PeerError {
  return value instanceof PeerError
}
