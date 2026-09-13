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
// TWO DELIBERATE DIVERGENCES FROM THAT README, both in `info`.
//
// **The project is in it.** The README's scheme is pairwise — one rendezvous
// per pair of teammates, for all time, across every repository they share. That
// is one fewer connection per pair, and it buys a problem: two people who share
// three repositories have one session, of one indistinguishable shape, and
// nothing in the Noise transcript says which project any of it is for. Every
// per-project rule then has to be re-derived by hand at every point of use, and
// the day one of them is forgotten there is no second line of defence. Putting
// the project key in `info` makes a session *be* for a project, which is what
// the per-project roster checks were already pretending. It costs a connection
// per pair per shared repository — twenty-one instead of seven for a team of
// eight sharing three — and buys unlinkability between a pair's repositories as
// well: the relay cannot tell that two rendezvous are the same two people.
//
// **The encoding is pinned.** The README writes `info = epoch` without saying
// how the number is encoded. Nothing in the relay depends on the answer — to it
// a rendezvous is 32 opaque bytes — but two peers who disagree never meet and
// are never told why. So `info` is a versioned, unambiguous, structured string,
// covered by a test with a fixed vector, and a change to it fails loudly rather
// than quietly stranding every peer on the spelling they had before.
//
// The relay needs no change for either: "a team that wanted a different scheme,
// or a fixed token per pair, would not have to change a line of it."

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

/**
 * The rendezvous for one pair, in one project, in one hour.
 *
 * `info` is versioned and structured rather than a bare number: the project key
 * is a fixed 64 hex characters and the epoch is decimal digits, separated by
 * newlines, so no two different inputs can produce the same string. The version
 * tag is what makes a future change to any of that a loud failure instead of a
 * silent one.
 *
 * 64 lowercase hex characters out, which is the only shape the relay accepts.
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
 * Bound into the Noise transcript by both sides, and never optional.
 *
 * `IK` authenticates two static keys and says nothing about what they are
 * talking about. The prologue is the only place a fact can be put that both
 * sides must already agree on and that an attacker cannot influence, so the
 * project and the rendezvous go in it: a transcript then answers "which project
 * is this session for" rather than leaving every caller to re-derive it.
 *
 * Both peers necessarily hold the same token — the relay pairs connections that
 * presented identical ones, and nothing else — so this can never be the reason
 * a legitimate handshake fails.
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
