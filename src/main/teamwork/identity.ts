// This installation's keypair: generated once, and the one secret in the
// product.
//
// It lives in the app's own data directory and nowhere else. That is the whole
// reason this module exists separately from the roster: the public half is
// meant to be committed and the private half must never be, and the surest way
// to keep them apart is for the private one never to be under a repository at
// all.
//
// `loadIdentity` returns the public half and the *path* of the private one, so
// a caller that genuinely needs the secret has to ask for it deliberately. That
// is not ceremony. A secret that is never in a value cannot be spread into a
// result, an error message, or a log line by code that had no idea it was
// carrying one.
//
// `loadStaticPrivateKey` is that deliberate ask, and it is the only way to get
// the bytes. It exists because a Noise `IK` handshake and the rendezvous
// derivation both need the raw scalar, which is the milestone B this module's
// first draft was waiting for. Nothing it returns may reach a method result, a
// `RuntimeError`, or a log line.

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { internal } from '../runtime/runtimeError'

export const IDENTITY_FILE_NAME = 'identity.key'

/**
 * Owner read/write and nothing else.
 *
 * On Windows this is close to meaningless — node maps the mode onto the
 * read-only attribute and nothing resembling an ACL — so what protects the file
 * there is where it is: `%APPDATA%\teamree`, which already inherits an ACL
 * scoped to the user who owns the profile. Doing better would mean shelling out
 * to icacls to strip inherited entries, which is a real thing to do and is not
 * worth doing before anything uses the key.
 */
export const PRIVATE_KEY_MODE = 0o600

export type Identity = {
  /** Base64 of the 32-byte X25519 public key. */
  publicKey: string
  /** Where the private half lives. Its contents are deliberately not here. */
  privateKeyPath: string
}

/**
 * The keypair for this installation, generating it the first time.
 *
 * Creation is exclusive, so two runtimes starting at once cannot each generate
 * a key and leave whoever lost the race with an identity the roster has never
 * heard of: the one that loses reads what the winner wrote.
 */
export async function loadIdentity(dataDir: string): Promise<Identity> {
  const privateKeyPath = join(dataDir, IDENTITY_FILE_NAME)

  const existing = await readIfPresent(privateKeyPath)
  if (existing !== undefined) {
    await restrict(privateKeyPath)
    return { publicKey: publicKeyOf(existing, privateKeyPath), privateKeyPath }
  }

  await mkdir(dataDir, { recursive: true })
  const pem = generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  try {
    const handle = await open(privateKeyPath, 'wx', PRIVATE_KEY_MODE)
    try {
      await handle.writeFile(pem, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const won = await readFile(privateKeyPath, 'utf8')
    return { publicKey: publicKeyOf(won, privateKeyPath), privateKeyPath }
  }

  await restrict(privateKeyPath)
  return { publicKey: publicKeyOf(pem, privateKeyPath), privateKeyPath }
}

/**
 * The raw 32-byte X25519 scalar for this installation.
 *
 * Deliberately separate from `loadIdentity`, and deliberately named for what it
 * hands over. Hold it for as long as one handshake needs and no longer; it is
 * never a field on anything that gets serialised.
 */
export async function loadStaticPrivateKey(dataDir: string): Promise<Uint8Array> {
  const identity = await loadIdentity(dataDir)
  const pem = await readFile(identity.privateKeyPath, 'utf8')
  return privateScalarFromPem(pem, identity.privateKeyPath)
}

/**
 * The public half of a stored private key.
 *
 * Exported for the test that proves the two halves belong together; everything
 * else should be reaching for `loadIdentity`.
 */
export function publicKeyFromPrivatePem(pem: string): string {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  // An X25519 SubjectPublicKeyInfo is a fixed 12-byte header and then the key.
  // The raw 32 bytes are what goes in the roster and what a Noise handshake
  // will want later; the header would only be a thing to strip twice.
  if (der.length !== 44) throw internal('the stored key is not an X25519 key')
  return Buffer.from(der.subarray(der.length - 32)).toString('base64')
}

/**
 * A PKCS#8 X25519 private key is a fixed 16-byte prologue and then the scalar,
 * the same way its public counterpart is a fixed header and then the point.
 */
function privateScalarFromPem(pem: string, path: string): Uint8Array {
  let der: Buffer
  try {
    der = createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' })
  } catch {
    throw unusableIdentity(path)
  }
  if (der.length !== 48) throw unusableIdentity(path)
  return new Uint8Array(der.subarray(der.length - 32))
}

function publicKeyOf(pem: string, path: string): string {
  try {
    return publicKeyFromPrivatePem(pem)
  } catch {
    throw unusableIdentity(path)
  }
}

/**
 * Deliberately says nothing about the contents: the file is unreadable as a
 * key, and quoting it back would be quoting a secret into a log.
 */
function unusableIdentity(path: string): Error {
  return internal(`${path} is not a usable teamree identity; move it aside and teamree will make a new one`)
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Best effort, and only ever tightening. A key restored from a backup can come
 * back world-readable, and a filesystem that cannot do modes at all — a network
 * share, a Windows volume — must not stop the app from running.
 */
async function restrict(path: string): Promise<void> {
  await chmod(path, PRIVATE_KEY_MODE).catch(() => {})
}
