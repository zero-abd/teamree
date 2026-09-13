// CipherState, SymmetricState and HandshakeState, following the Noise
// specification (revision 34) sections 5.1, 5.2 and 5.3.
//
// This is deliberately a transliteration of the spec's pseudocode rather than
// something tidier. Each function keeps the spec's name and the spec's order of
// operations so that an auditor can read the two side by side; where a local
// name differs from the spec's it is only to satisfy the linter.
//
// It is driven by a pattern table rather than hard-coding IK. That is not
// generality for its own sake: it is what lets `noiseVectors.test.ts` run this
// exact code against all thirty-eight published `25519_ChaChaPoly_SHA256`
// vectors instead of the single IK one. The library exports only IK (see
// `session.ts`); the other patterns live in the test as data.
//
// Nothing here is the public API. Callers use `session.ts`.

import { PeerErrorCode, peerError } from './errors'
import {
  aeadDecrypt,
  aeadEncrypt,
  concat,
  DH_LEN,
  dh,
  generateKeyPair,
  hash,
  HASH_LEN,
  hkdf,
  type KeyPair,
  MAX_MESSAGE_LEN,
  MAX_NONCE,
  type RandomSource,
  TAG_LEN,
  wipe
} from './primitives'

const EMPTY = new Uint8Array(0)

/**
 * Only `s` appears in the pre-messages of every pattern this library and its
 * test corpus use. Pre-message `e` exists in the spec's fallback patterns,
 * which we do not implement; leaving it out of the type means an unsupported
 * pattern fails to compile rather than silently skipping a MixHash.
 */
export type PreMessageToken = 's'

export type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss'

export type HandshakePattern = {
  readonly name: string
  readonly initiatorPreMessage: readonly PreMessageToken[]
  readonly responderPreMessage: readonly PreMessageToken[]
  readonly messages: readonly (readonly Token[])[]
}

/** This library implements exactly one cipher suite; see `primitives.ts` for why. */
const SUITE = '25519_ChaChaPoly_SHA256'

/**
 * The protocol name is derived from the pattern rather than passed beside it,
 * so a caller cannot bind a transcript to a name that describes a different
 * handshake than the one it is actually running.
 */
export function protocolNameFor(pattern: HandshakePattern): string {
  return `Noise_${pattern.name}_${SUITE}`
}

// ---------------------------------------------------------------------------
// CipherState (spec 5.1)
// ---------------------------------------------------------------------------

export type CipherState = {
  k: Uint8Array | null
  n: bigint
}

export function initializeKey(k: Uint8Array | null): CipherState {
  return { k, n: 0n }
}

export function hasKey(cs: CipherState): boolean {
  return cs.k !== null
}

/**
 * The spec reserves n = 2^64 - 1 and requires that reaching it be signalled as
 * an error. Checking before use, and never incrementing past the ceiling, means
 * there is no arithmetic path on which a nonce repeats: the counter stops and
 * every later call throws the same way.
 */
function useNonce(cs: CipherState): bigint {
  if (cs.n >= MAX_NONCE) throw peerError(PeerErrorCode.NonceExhausted)
  const nonce = cs.n
  cs.n += 1n
  return nonce
}

export function encryptWithAd(cs: CipherState, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (cs.k === null) return plaintext
  return aeadEncrypt(cs.k, useNonce(cs), ad, plaintext)
}

export function decryptWithAd(cs: CipherState, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (cs.k === null) return ciphertext
  // The nonce is consumed whether or not the tag verifies. A failed decryption
  // ends the session, so there is no resynchronisation to preserve, and not
  // rewinding keeps an attacker from replaying a message to pin the counter.
  return aeadDecrypt(cs.k, useNonce(cs), ad, ciphertext)
}

// ---------------------------------------------------------------------------
// SymmetricState (spec 5.2)
// ---------------------------------------------------------------------------

export type SymmetricState = {
  cipher: CipherState
  ck: Uint8Array
  h: Uint8Array
}

export function initializeSymmetric(protocolName: string): SymmetricState {
  const name = new TextEncoder().encode(protocolName)
  // Spec 5.2: names of HASHLEN bytes or fewer are used as-is, zero-padded;
  // longer ones are hashed. `Noise_IK_25519_ChaChaPoly_SHA256` is exactly 32
  // bytes, so it lands on the padding branch with no padding to do.
  let h: Uint8Array
  if (name.length <= HASH_LEN) {
    h = new Uint8Array(HASH_LEN)
    h.set(name)
  } else {
    h = hash(name)
  }
  return { cipher: initializeKey(null), ck: h.slice(), h }
}

export function mixKey(ss: SymmetricState, inputKeyMaterial: Uint8Array): void {
  const [ck, tempK] = hkdf(ss.ck, inputKeyMaterial)
  ss.ck = ck
  ss.cipher = initializeKey(tempK)
}

export function mixHash(ss: SymmetricState, data: Uint8Array): void {
  ss.h = hash(concat(ss.h, data))
}

export function encryptAndHash(ss: SymmetricState, plaintext: Uint8Array): Uint8Array {
  const ciphertext = encryptWithAd(ss.cipher, ss.h, plaintext)
  mixHash(ss, ciphertext)
  return ciphertext
}

export function decryptAndHash(ss: SymmetricState, ciphertext: Uint8Array): Uint8Array {
  const plaintext = decryptWithAd(ss.cipher, ss.h, ciphertext)
  // The spec hashes the ciphertext, not the plaintext, and only after a
  // successful decryption — so a rejected message leaves the transcript alone.
  mixHash(ss, ciphertext)
  return plaintext
}

/**
 * Keyed by direction rather than by the spec's `c1`/`c2`, because every caller
 * of this immediately has to work out which is which and the names are where
 * that goes wrong.
 */
export type TransportKeys = {
  readonly initiatorToResponder: CipherState
  readonly responderToInitiator: CipherState
}

export function split(ss: SymmetricState): TransportKeys {
  const [k1, k2] = hkdf(ss.ck, EMPTY)
  return {
    initiatorToResponder: initializeKey(k1),
    responderToInitiator: initializeKey(k2)
  }
}

// ---------------------------------------------------------------------------
// HandshakeState (spec 5.3)
// ---------------------------------------------------------------------------

export type HandshakeConfig = {
  readonly pattern: HandshakePattern
  readonly initiator: boolean
  readonly prologue: Uint8Array
  readonly staticKeyPair: KeyPair | null
  readonly remoteStaticPublicKey: Uint8Array | null
  readonly random: RandomSource
  /**
   * Called the instant a peer's static public key is decrypted out of a
   * handshake message, before any further token is processed. Returning false
   * aborts the handshake. This is where IK earns its place: it is the roster
   * check, and it happens before we have sent anything back.
   */
  readonly acceptRemoteStatic?: (staticPublicKey: Uint8Array) => boolean
}

export type HandshakeState = {
  symmetric: SymmetricState
  s: KeyPair | null
  e: KeyPair | null
  rs: Uint8Array | null
  re: Uint8Array | null
  readonly initiator: boolean
  readonly pattern: HandshakePattern
  readonly random: RandomSource
  readonly acceptRemoteStatic: ((staticPublicKey: Uint8Array) => boolean) | undefined
  messageIndex: number
}

export function initializeHandshake(config: HandshakeConfig): HandshakeState {
  const symmetric = initializeSymmetric(protocolNameFor(config.pattern))
  mixHash(symmetric, config.prologue)

  const hs: HandshakeState = {
    symmetric,
    s: config.staticKeyPair,
    e: null,
    rs: config.remoteStaticPublicKey,
    re: null,
    initiator: config.initiator,
    pattern: config.pattern,
    random: config.random,
    acceptRemoteStatic: config.acceptRemoteStatic,
    messageIndex: 0
  }

  // Spec 5.3: hash every pre-message public key, initiator's side first,
  // regardless of which side we are. Getting this order wrong produces two
  // transcripts that differ only in a way the handshake will not detect until
  // the first decryption fails.
  for (const token of config.pattern.initiatorPreMessage) {
    if (token === 's') mixHash(symmetric, requirePreMessageKey(hs, config.initiator))
  }
  for (const token of config.pattern.responderPreMessage) {
    if (token === 's') mixHash(symmetric, requirePreMessageKey(hs, !config.initiator))
  }

  return hs
}

/** The static public key belonging to whichever side the pre-message names. */
function requirePreMessageKey(hs: HandshakeState, ours: boolean): Uint8Array {
  const key = ours ? hs.s?.publicKey : hs.rs
  if (!key) throw peerError(PeerErrorCode.InvalidKey)
  return key
}

export type HandshakeStep = {
  /** The bytes to put on the wire, or the decrypted payload, depending on direction. */
  readonly bytes: Uint8Array
  /** Non-null exactly when this was the pattern's final message. */
  readonly transport: TransportKeys | null
}

function currentMessage(hs: HandshakeState): readonly Token[] {
  const message = hs.pattern.messages[hs.messageIndex]
  if (!message) throw peerError(PeerErrorCode.OutOfTurn)
  return message
}

function mixDiffieHellman(hs: HandshakeState, token: 'ee' | 'es' | 'se' | 'ss'): void {
  // Spec 5.3: `es` is always initiator-ephemeral with responder-static and `se`
  // always the reverse, so which local key each side uses depends on its role.
  const local = token === 'ee' || (token === 'es' && hs.initiator) || (token === 'se' && !hs.initiator) ? hs.e : hs.s
  const remote = token === 'ee' || (token === 'se' && hs.initiator) || (token === 'es' && !hs.initiator) ? hs.re : hs.rs
  if (!local || !remote) throw peerError(PeerErrorCode.InvalidKey)
  const secret = dh(local.privateKey, remote)
  mixKey(hs.symmetric, secret)
  wipe(secret)
}

export function writeMessage(hs: HandshakeState, payload: Uint8Array): HandshakeStep {
  const tokens = currentMessage(hs)
  const parts: Uint8Array[] = []

  for (const token of tokens) {
    if (token === 'e') {
      hs.e = generateKeyPair(hs.random)
      parts.push(hs.e.publicKey)
      mixHash(hs.symmetric, hs.e.publicKey)
    } else if (token === 's') {
      if (!hs.s) throw peerError(PeerErrorCode.InvalidKey)
      parts.push(encryptAndHash(hs.symmetric, hs.s.publicKey))
    } else {
      mixDiffieHellman(hs, token)
    }
  }

  parts.push(encryptAndHash(hs.symmetric, payload))
  const message = concat(...parts)
  if (message.length > MAX_MESSAGE_LEN) throw peerError(PeerErrorCode.MessageTooLong)

  hs.messageIndex += 1
  return { bytes: message, transport: finishedTransport(hs) }
}

export function readMessage(hs: HandshakeState, message: Uint8Array): HandshakeStep {
  if (message.length > MAX_MESSAGE_LEN) throw peerError(PeerErrorCode.MessageTooLong)
  const tokens = currentMessage(hs)
  let offset = 0

  const take = (length: number): Uint8Array => {
    if (message.length - offset < length) throw peerError(PeerErrorCode.Truncated)
    const slice = message.subarray(offset, offset + length)
    offset += length
    return slice
  }

  for (const token of tokens) {
    if (token === 'e') {
      hs.re = take(DH_LEN).slice()
      mixHash(hs.symmetric, hs.re)
    } else if (token === 's') {
      const encrypted = take(hasKey(hs.symmetric.cipher) ? DH_LEN + TAG_LEN : DH_LEN)
      const remoteStatic = decryptAndHash(hs.symmetric, encrypted)
      if (remoteStatic.length !== DH_LEN) throw peerError(PeerErrorCode.InvalidKey)
      // The roster check runs here, on the first message that carries a static
      // key, so an unrecognised peer is refused before we mix any further
      // secret or write a single byte back to it.
      if (hs.acceptRemoteStatic && !hs.acceptRemoteStatic(remoteStatic)) {
        throw peerError(PeerErrorCode.UnknownPeer)
      }
      hs.rs = remoteStatic.slice()
    } else {
      mixDiffieHellman(hs, token)
    }
  }

  const payload = decryptAndHash(hs.symmetric, message.subarray(offset))
  hs.messageIndex += 1
  return { bytes: payload, transport: finishedTransport(hs) }
}

function finishedTransport(hs: HandshakeState): TransportKeys | null {
  if (hs.messageIndex < hs.pattern.messages.length) return null
  return split(hs.symmetric)
}

/** The transcript hash, valid only once the handshake has completed. */
export function handshakeHash(hs: HandshakeState): Uint8Array {
  return hs.symmetric.h.slice()
}

/** Best-effort erasure of the handshake's own secrets once it is finished or dead. */
export function destroyHandshake(hs: HandshakeState): void {
  wipe(hs.e?.privateKey ?? null)
  wipe(hs.symmetric.ck)
  wipe(hs.symmetric.cipher.k)
  hs.e = null
  hs.symmetric.cipher.k = null
}
