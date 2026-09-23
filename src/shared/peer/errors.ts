// The one error type this library throws. No message parameter: throw sites share scope with keys and
// nonces, so the text comes from a frozen table by code. Need more context? Add a code.

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
  /** A payload was offered on, or arrived in, the first handshake message, which is replayable. */
  ReplayablePayload: 'replayable_payload',
  /** The peer has not yet proved it holds the static key it claimed. */
  UnconfirmedPeer: 'unconfirmed_peer',
  /** The 2^64 - 1 nonce ceiling was reached. The session must be rebuilt, never wrapped. */
  NonceExhausted: 'nonce_exhausted'
} as const

export type PeerErrorCode = (typeof PeerErrorCode)[keyof typeof PeerErrorCode]

/** Fixed, secret-free text per code, frozen so nothing can smuggle a value in. */
const MESSAGES: Readonly<Record<PeerErrorCode, string>> = Object.freeze({
  [PeerErrorCode.InvalidKey]: 'key material was not a usable X25519 key of the expected length',
  [PeerErrorCode.OutOfTurn]: 'the session is not at a point where this call means anything',
  [PeerErrorCode.SessionClosed]: 'the session is closed and cannot be used again',
  [PeerErrorCode.Truncated]: 'the message is shorter than the handshake pattern requires',
  [PeerErrorCode.MessageTooLong]: 'the message exceeds the 65535-byte Noise limit',
  [PeerErrorCode.DecryptionFailed]: 'authentication failed; the message was not produced by this session',
  [PeerErrorCode.UnknownPeer]: 'the peer static key is not on the roster',
  [PeerErrorCode.ReplayablePayload]: 'the first handshake message carries no payload, because it can be replayed',
  [PeerErrorCode.UnconfirmedPeer]: 'the peer has not yet proved it holds the static key it claimed',
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
