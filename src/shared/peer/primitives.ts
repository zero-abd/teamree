// The four primitives Noise names, and nothing else.
//
// Cipher suite: Noise_*_25519_ChaChaPoly_SHA256.
//
// ChaCha20-Poly1305 rather than AES-GCM, for two reasons that both come from
// this being a desktop app rather than a server fleet:
//
//   1. It is fast and constant-time in software on every machine. AES-GCM is
//      only safe-and-fast where AES-NI exists; where it does not, a portable
//      AES is either slow or cache-timing-leaky, and we do not get to choose
//      our users' laptops. ChaCha20 has no data-dependent table lookups at all.
//   2. Its nonce misuse cliff is further away. Both ciphers fail catastrophically
//      on nonce reuse, but GCM's authentication key is recoverable from a single
//      repeat, which makes an implementation slip unrecoverable rather than
//      merely bad. Noise's nonce is a counter we control, so neither should ever
//      happen, but the cheaper failure is the better default.
//
// AES-GCM would be the better pick if we were terminating thousands of sessions
// per second on hardware we owned. We are terminating one per teammate.
//
// This module deliberately does not offer cipher agility. A single hard-coded
// suite means there is no negotiation to downgrade, and the protocol name that
// binds the suite into the transcript can be a constant.

import {
  createCipheriv,
  createDecipheriv,
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

const CIPHER = 'chacha20-poly1305'

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

// Node has no raw-bytes import for X25519, so we wrap the scalar in the minimal
// DER that RFC 8410 defines for it. The prefixes encode "algorithm is id-X25519
// (1.3.101.110), payload is a 32-byte OCTET STRING", and never vary, so they are
// constants rather than a DER encoder.
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
 * X25519. OpenSSL rejects the low-order points that produce an all-zero shared
 * secret, which is the check the Noise specification calls optional and every
 * serious implementation performs. We let that rejection surface as an error
 * rather than continuing with a contributory-behaviour-free secret.
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
 * Noise's HKDF (specification section 4.3), spelled out as the spec spells it
 * rather than called through `crypto.hkdfSync`. It is the same construction,
 * but here the correspondence to the spec text is visible and there is no
 * salt/info argument order to get backwards. `primitives.test.ts` checks it
 * against Node's HKDF, so the choice costs nothing in assurance.
 *
 * Two outputs only. The third is needed solely by `MixKeyAndHash`, which is
 * PSK machinery this library does not implement.
 */
export function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(chainingKey, inputKeyMaterial)
  const first = hmac(tempKey, Uint8Array.of(1))
  const second = hmac(tempKey, concat(first, Uint8Array.of(2)))
  return [first, second]
}

/**
 * The 96-bit AEAD nonce Noise specifies for ChaChaPoly: 32 zero bits followed by
 * the 64-bit counter, little-endian. AES-GCM would want the same counter
 * big-endian; getting this backwards is the classic way two implementations of
 * the same suite fail to talk to each other, which is why the test vectors
 * matter more here than anywhere else in the library.
 */
function nonceBytes(nonce: bigint): Buffer {
  const iv = Buffer.alloc(12)
  iv.writeBigUInt64LE(nonce, 4)
  return iv
}

export function aeadEncrypt(
  key: Uint8Array,
  nonce: bigint,
  associatedData: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  requireLength(key, HASH_LEN)
  const cipher = createCipheriv(CIPHER, key, nonceBytes(nonce), { authTagLength: TAG_LEN })
  // `plaintextLength` is required by the CCM-shaped signature Node gives every
  // `authTagLength` cipher. ChaCha20-Poly1305 does not need it declared up
  // front, but stating it truthfully costs nothing.
  cipher.setAAD(associatedData, { plaintextLength: plaintext.length })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]))
}

export function aeadDecrypt(
  key: Uint8Array,
  nonce: bigint,
  associatedData: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  requireLength(key, HASH_LEN)
  if (ciphertext.length < TAG_LEN) throw peerError(PeerErrorCode.DecryptionFailed)
  const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN)
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN)
  const decipher = createDecipheriv(CIPHER, key, nonceBytes(nonce), { authTagLength: TAG_LEN })
  decipher.setAAD(associatedData, { plaintextLength: body.length })
  decipher.setAuthTag(tag)
  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]))
  } catch {
    // Every decryption failure looks identical from outside: a forgery, a
    // replay and a truncation must not be distinguishable by error or by which
    // branch we took to get here.
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

/**
 * Best-effort erasure. JavaScript cannot promise this — the garbage collector
 * may already have copied the buffer, and strings are immutable — so treat it as
 * shortening the window, not closing it.
 */
export function wipe(bytes: Uint8Array | null): void {
  if (bytes) bytes.fill(0)
}
