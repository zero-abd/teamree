// This installation's keypair, in the app's data directory and never under a repository. `loadIdentity`
// returns the public half and the *path* of the private one; `loadStaticPrivateKey` is the only way to the
// bytes, and nothing it returns may reach a method result, a `RuntimeError`, or a log line.

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { internal } from '../runtime/runtimeError'

export const IDENTITY_FILE_NAME = 'identity.key'

/**
 * Owner read/write. On Windows node maps the mode onto the read-only attribute, so what protects the file
 * there is `%APPDATA%\teamree`, which inherits an ACL scoped to the profile's owner.
 */
export const PRIVATE_KEY_MODE = 0o600

export type Identity = {
  /** Base64 of the 32-byte X25519 public key. */
  publicKey: string
  /** Where the private half lives. Its contents are deliberately not here. */
  privateKeyPath: string
}

/**
 * The keypair for this installation, generated the first time. Creation is exclusive, so two runtimes
 * starting at once cannot each generate a key: the one that loses the race reads what the winner wrote.
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

/** The raw 32-byte X25519 scalar. Hold it for one handshake and no longer; never a field on anything serialised. */
export async function loadStaticPrivateKey(dataDir: string): Promise<Uint8Array> {
  const identity = await loadIdentity(dataDir)
  const pem = await readFile(identity.privateKeyPath, 'utf8')
  return privateScalarFromPem(pem, identity.privateKeyPath)
}

/** The public half of a stored private key. Exported for the test that proves the halves belong together. */
export function publicKeyFromPrivatePem(pem: string): string {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  // An X25519 SubjectPublicKeyInfo is a fixed 12-byte header and then the raw 32-byte key.
  if (der.length !== 44) throw internal('the stored key is not an X25519 key')
  return Buffer.from(der.subarray(der.length - 32)).toString('base64')
}

/** A PKCS#8 X25519 private key is a fixed 16-byte prologue and then the scalar. */
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

/** Says nothing about the contents: quoting an unreadable key file back would be quoting a secret into a log. */
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
 * Best effort, only ever tightening: a key restored from a backup can come back world-readable, and a
 * filesystem that cannot do modes must not stop the app.
 */
async function restrict(path: string): Promise<void> {
  await chmod(path, PRIVATE_KEY_MODE).catch(() => {})
}
