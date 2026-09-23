// The four primitives Noise names, and nothing else.
// Cipher suite: Noise_*_25519_ChaChaPoly_SHA256, hard-coded: no agility, no
// negotiation to downgrade, and the protocol name is a constant.
// ChaCha20-Poly1305 over AES-GCM because it is constant-time in software on
// every laptop (AES-GCM needs AES-NI) and a nonce repeat does not hand over
// the authentication key the way GCM's does.
//
// The AEAD is `@noble/ciphers`, not `node:crypto`: Electron links BoringSSL,
// which does not expose `chacha20-poly1305` through `createCipheriv`, so the
// first handshake of every shipped build threw "Unknown cipher" while vitest
// stayed green under Node's OpenSSL. Keeping the suite keeps `noiseVectors.json`,
// the only evidence our bytes match anybody else's. Measured: 5.5µs against
// 12.4µs for 256-byte frames, 178 MB/s against 1064 MB/s at the 64 KiB maximum.
// One implementation, both runtimes; no native path where it happens to exist.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes as nodeRandomBytes,
  timingSafeEqual
} from 'node:crypto'
import { PeerErrorCode, peerError } from './errors'

/** X25519 public keys, private keys, and shared secrets are all 32 bytes. */
export const DH_LEN = 32
/** SHA-256 output, which is also the Noise chaining-key and cipher-key length. */
export const HASH_LEN = 32
/** Poly1305 authentication tag. */
export const TAG_LEN = 16
/** Noise fixes the maximum size of any one message on the wire. */
export const MAX_MESSAGE_LEN = 65535
/** The largest nonce Noise permits. Reaching it is an error, never a wrap. */
export const MAX_NONCE = 2n ** 64n - 1n

/**
 * Randomness, injected so tests can pin ephemerals to the specification's test
 * vectors. Production passes nothing and gets the platform CSPRNG.
 */
export type RandomSource = (length: number) => Uint8Array

export const systemRandom: RandomSource = (length) => new Uint8Array(nodeRandomBytes(length))

export type KeyPair = {
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

// Node has no raw-bytes import for X25519, so the scalar is wrapped in the
// minimal RFC 8410 DER: id-X25519 (1.3.101.110) plus a 32-byte OCTET STRING.
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function requireLength(bytes: Uint8Array, length: number): void {
  if (bytes.length !== length) throw peerError(PeerErrorCode.InvalidKey)
}

function privateKeyObject(privateKey: Uint8Array): ReturnType<typeof createPrivateKey> {
  requireLength(privateKey, DH_LEN)
  try {
    return createPrivateKey({
      key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]),
      format: 'der',
      type: 'pkcs8'
    })
  } catch {
    // Swallowed on purpose: OpenSSL's message can quote the input.
    throw peerError(PeerErrorCode.InvalidKey)
  }
}

function publicKeyObject(publicKey: Uint8Array): ReturnType<typeof createPublicKey> {
  requireLength(publicKey, DH_LEN)
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_X25519_PREFIX, publicKey]),
      format: 'der',
      type: 'spki'
    })
  } catch {
    throw peerError(PeerErrorCode.InvalidKey)
  }
}

/** The public half of a static key, so callers only ever store the private half. */
export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: 'der', type: 'spki' })
  return new Uint8Array(spki.subarray(SPKI_X25519_PREFIX.length))
}

export function generateKeyPair(random: RandomSource): KeyPair {
  const privateKey = new Uint8Array(random(DH_LEN))
  requireLength(privateKey, DH_LEN)
  return { privateKey, publicKey: derivePublicKey(privateKey) }
}

/**
 * X25519. OpenSSL rejects low-order points that give an all-zero shared secret
 * (the check Noise calls optional); that rejection surfaces as an error.
 */
export function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const priv = privateKeyObject(privateKey)
  const pub = publicKeyObject(publicKey)
  try {
    return new Uint8Array(diffieHellman({ privateKey: priv, publicKey: pub }))
  } catch {
    throw peerError(PeerErrorCode.InvalidKey)
  }
}

export function hash(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest())
}

/**
 * Noise's HKDF (spec section 4.3), spelled as the spec spells it so there is no
 * salt/info order to get backwards; `primitives.test.ts` checks it against Node's.
 * Two outputs only: the third is PSK machinery this library does not implement.
 */
export function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(chainingKey, inputKeyMaterial)
  const first = hmac(tempKey, Uint8Array.of(1))
  const second = hmac(tempKey, concat(first, Uint8Array.of(2)))
  return [first, second]
}

/**
 * Noise's 96-bit ChaChaPoly nonce: 32 zero bits then the 64-bit counter,
 * little-endian (AES-GCM wants big-endian; the test vectors catch a mix-up).
 */
function nonceBytes(nonce: bigint): Uint8Array {
  const iv = Buffer.alloc(12)
  iv.writeBigUInt64LE(nonce, 4)
  return new Uint8Array(iv.buffer, iv.byteOffset, iv.length)
}

export function aeadEncrypt(
  key: Uint8Array,
  nonce: bigint,
  associatedData: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  requireLength(key, HASH_LEN)
  // Appends the 16-byte tag, which is what Noise's ENCRYPT() means by "ciphertext".
  return chacha20poly1305(key, nonceBytes(nonce), associatedData).encrypt(plaintext)
}

export function aeadDecrypt(
  key: Uint8Array,
  nonce: bigint,
  associatedData: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  requireLength(key, HASH_LEN)
  if (ciphertext.length < TAG_LEN) throw peerError(PeerErrorCode.DecryptionFailed)
  try {
    return chacha20poly1305(key, nonceBytes(nonce), associatedData).decrypt(ciphertext)
  } catch {
    // A forgery, a replay and a truncation must look identical from outside.
    throw peerError(PeerErrorCode.DecryptionFailed)
  }
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Length-independent so it can compare anything without leaking which check failed. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Best-effort erasure: the GC may already hold a copy, so this shortens the window, not closes it. */
export function wipe(bytes: Uint8Array | null): void {
  if (bytes) bytes.fill(0)
}
