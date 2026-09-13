// Identities for the two-peer harness.
//
// ═══ SEAM ═══
// Milestone A owns identity for real: the app generates its keypair on first
// run, keeps the private half on the machine, and writes the public half to
// `.teamree/members/<handle>.pub`. None of that exists yet.
//
// What this module does is mint a keypair itself, so the harness can stand two
// distinguishable peers up today. It depends on exactly two things
// `docs/teamwork.md` actually specifies — that the key is X25519, and that the
// public half lives at `.teamree/members/<handle>.pub` — and on one thing it
// does not: how the bytes of that file are spelled.
//
// When milestone A lands:
//   - `generateIdentity` should be replaced by asking the runtime for the
//     identity it already has, and the private key below should be deleted
//     rather than moved, because a harness that mints keys the app does not
//     know about will pass while proving nothing.
//   - If milestone A chose a different on-disk encoding, `PUBLIC_KEY_ENCODING`
//     and the two functions under it are the only places that need to change.

import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the roster lives, per docs/teamwork.md. */
export const MEMBERS_DIR = join('.teamree', 'members')

/**
 * SPKI PEM, which is what `node:crypto` exports without being asked twice.
 *
 * A guess, and flagged as one: `docs/teamwork.md` fixes the path and the
 * algorithm but never says whether the file holds 32 raw bytes, base64, or a
 * PEM wrapper. PEM is the guess most likely to survive review — it is ASCII, so
 * it diffs and reviews as a line rather than as a blob; it names its own
 * algorithm, so a key pasted into the wrong file is caught rather than
 * misinterpreted; and it is the one encoding every language's standard library
 * can already read.
 */
export const PUBLIC_KEY_ENCODING = 'spki-pem'

/**
 * A handle has to be a filename, and it ends up in a repository every member
 * clones, so it is kept to the characters that mean the same thing on every
 * filesystem. Case-folding matters more than it looks: macOS would treat
 * `Ana.pub` and `ana.pub` as one file and Linux as two, which is a membership
 * list that disagrees with itself across the team.
 */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/

export function assertHandle(handle) {
  if (!HANDLE.test(handle)) {
    throw new Error(`"${handle}" is not a usable handle: lowercase letters, digits and hyphens, up to 39 characters`)
  }
  return handle
}

/**
 * Mints one X25519 identity.
 *
 * @param {string} handle
 * @returns {{ handle: string, publicKey: string, privateKey: string }}
 */
export function generateIdentity(handle) {
  assertHandle(handle)
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    handle,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

/** The path a handle's public key occupies inside a checkout. */
export function memberKeyPath(repoPath, handle) {
  return join(repoPath, MEMBERS_DIR, `${assertHandle(handle)}.pub`)
}

/**
 * Writes one member's public key into a checkout. Deliberately does not commit
 * or push: getting the key into the repository is the step the runbook makes a
 * person do on purpose, and a harness that did it silently would hide the one
 * thing most likely to be forgotten.
 */
export async function writeMemberKey(repoPath, identity) {
  const path = memberKeyPath(repoPath, identity.handle)
  await mkdir(join(repoPath, MEMBERS_DIR), { recursive: true })
  await writeFile(path, identity.publicKey)
  return path
}

/**
 * Reads the roster out of a checkout: every `<handle>.pub` under
 * `.teamree/members/`, sorted, with anything else in the directory ignored.
 *
 * This is the harness's own reading of the roster, used to assert that a key
 * actually arrived. Milestone A will have its own, and when it does this should
 * defer to it rather than agreeing with it by coincidence.
 */
export async function readRoster(repoPath) {
  let names
  try {
    names = await readdir(join(repoPath, MEMBERS_DIR))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const members = []
  for (const name of names.sort()) {
    if (!name.endsWith('.pub')) continue
    const handle = name.slice(0, -'.pub'.length)
    if (!HANDLE.test(handle)) continue
    members.push({ handle, publicKey: await readFile(join(repoPath, MEMBERS_DIR, name), 'utf8') })
  }
  return members
}
