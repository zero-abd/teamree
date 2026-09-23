// How two teammates find each other on a relay told nothing about them: the
// client half of `relay/README.md`'s HKDF-over-X25519 scheme, diverging in
// `info` on purpose: the project key is in it, and the encoding is pinned.

import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, type KeyObject } from 'node:crypto'

/** The salt from the relay's scheme. Changing it is a protocol break. */
export const RENDEZVOUS_SALT = 'teamree/relay/rendezvous/v1'

/** Tokens rotate hourly, so no stable identifier accumulates against a pair. */
export const EPOCH_SECONDS = 3600

/** Version tags. Changing what goes into either derivation means changing these. */
export const RENDEZVOUS_VERSION = 'teamree/rendezvous/v2'
export const PROLOGUE_VERSION = 'teamree/peer/prologue/v2'

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

/** The 32 bytes only these two machines can compute. Raw scalar in, base64 as the roster spells it. */
export function sharedSecret(privateKey: Uint8Array, publicKeyBase64: string): Uint8Array {
  const shared = diffieHellman({
    privateKey: privateKeyObject(privateKey),
    publicKey: publicKeyObject(publicKeyBase64)
  })
  return new Uint8Array(shared)
}

/**
 * The rendezvous for one pair, in one project, in one hour. `info` is versioned
 * and structured so no two inputs collide and a change fails loudly. 64
 * lowercase hex characters out, the only shape the relay accepts.
 */
export function rendezvousToken(shared: Uint8Array, projectKey: string, epoch: number): string {
  const derived = hkdfSync('sha256', shared, RENDEZVOUS_SALT, rendezvousInfo(projectKey, epoch), TOKEN_BYTES)
  return Buffer.from(derived).toString('hex')
}

export function rendezvousInfo(projectKey: string, epoch: number): string {
  if (!/^[0-9a-f]{64}$/.test(projectKey)) throw new Error('a project key is 32 bytes as 64 hex characters')
  return `${RENDEZVOUS_VERSION}\n${projectKey}\n${epoch}`
}

/**
 * Bound into the Noise transcript by both sides: `IK` says nothing about what
 * the keys are talking about, so the project and the rendezvous go here. Both
 * peers hold the same token, so this never fails a legitimate handshake.
 */
export function sessionPrologue(projectKey: string, token: string): Uint8Array {
  return new Uint8Array(
    createHash('sha256')
      .update(`${PROLOGUE_VERSION}\n`)
      .update(rendezvousInfoPrefix(projectKey))
      .update(token, 'utf8')
      .digest()
  )
}

function rendezvousInfoPrefix(projectKey: string): string {
  if (!/^[0-9a-f]{64}$/.test(projectKey)) throw new Error('a project key is 32 bytes as 64 hex characters')
  return `${projectKey}\n`
}

/** What goes in the URL: the token's hash, which names the pairing without being it. */
export function rendezvousId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** `<relay>/<sha256-of-token>`, tolerant of a trailing slash on the configured URL. */
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
