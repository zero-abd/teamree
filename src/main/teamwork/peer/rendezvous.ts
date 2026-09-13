// How two teammates find each other on a relay that is told nothing about them.
//
// The scheme is `relay/README.md`'s, not ours, and this file is the client half
// of it. Both peers already share something the relay does not — the
// static-static Diffie-Hellman between their two X25519 keys — so that secret
// seeds a token both can compute and nobody else can:
//
//   shared = X25519(my_private_key, their_public_key)
//   epoch  = floor(unix_seconds / 3600)
//   token  = HKDF-SHA256(ikm = shared, salt = "teamree/relay/rendezvous/v1",
//                        info = epoch, length = 32)
//
// The token goes in the first frame; `SHA-256(token)` in hex goes in the URL,
// because a URL reaches proxy logs and error reports and the token is a
// capability, while its hash names the same pairing without conferring one.
//
// One decision the README leaves open: it writes `info = epoch` without saying
// how the number is encoded. Nothing in the relay depends on the answer — to it
// a rendezvous is 32 opaque bytes — but the two peers have to agree exactly, so
// it is pinned here as the epoch's decimal digits in ASCII and covered by a
// test with a fixed vector, so a change to it fails loudly rather than quietly
// stranding every peer on the spelling they had before.

import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, type KeyObject } from 'node:crypto'

/** The salt from the relay's scheme. Changing it is a protocol break. */
export const RENDEZVOUS_SALT = 'teamree/relay/rendezvous/v1'

/** Tokens rotate hourly, so no stable identifier accumulates against a pair. */
export const EPOCH_SECONDS = 3600

const TOKEN_BYTES = 32

/** X25519 SubjectPublicKeyInfo: a fixed 12-byte prologue, then the 32-byte point. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** PKCS#8 for X25519 is as fixed as the SPKI is: a 16-byte prologue, then the scalar. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function epochAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / EPOCH_SECONDS)
}

/** When the epoch containing `nowMs` gives way to the next one. */
export function epochEndsAt(nowMs: number): number {
  return (epochAt(nowMs) + 1) * EPOCH_SECONDS * 1000
}

/**
 * The 32 bytes only these two machines can compute.
 *
 * `privateKey` is the raw scalar and `publicKey` is base64 exactly as the
 * roster files spell it, so no caller has to hold a DER anything.
 */
export function sharedSecret(privateKey: Uint8Array, publicKeyBase64: string): Uint8Array {
  const shared = diffieHellman({
    privateKey: privateKeyObject(privateKey),
    publicKey: publicKeyObject(publicKeyBase64)
  })
  return new Uint8Array(shared)
}

/** 64 lowercase hex characters, which is the only shape the relay accepts. */
export function rendezvousToken(shared: Uint8Array, epoch: number): string {
  const derived = hkdfSync('sha256', shared, RENDEZVOUS_SALT, String(epoch), TOKEN_BYTES)
  return Buffer.from(derived).toString('hex')
}

/** What goes in the URL: the token's hash, which names the pairing without being it. */
export function rendezvousId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * `<relay>/<sha256-of-token>`, built so a trailing slash on the configured URL
 * cannot produce a doubled path the relay answers with a 404.
 */
export function rendezvousUrl(relayUrl: string, token: string): string {
  return `${relayUrl.replace(/\/+$/, '')}/${rendezvousId(token)}`
}

function privateKeyObject(privateKey: Uint8Array): KeyObject {
  if (privateKey.length !== 32) throw new Error('an X25519 private key is 32 bytes')
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKey)])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

function publicKeyObject(publicKeyBase64: string): KeyObject {
  const raw = Buffer.from(publicKeyBase64, 'base64')
  if (raw.length !== 32) throw new Error('an X25519 public key is 32 bytes')
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}
