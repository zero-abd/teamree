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
 * The format milestone A actually shipped: a short comment header, then
 * `handle:`, `key: x25519 <base64 of the raw 32 bytes>`, and `added:`.
 *
 * This was a guess when the harness was written — the design fixed the path and
 * the algorithm but never the encoding — and the guess (SPKI PEM) was wrong.
 * `src/main/teamwork/memberFile.ts` is the authority, and a test asserts that
 * what this writes parses there, so the two cannot drift apart again without
 * something going red.
 */
export const PUBLIC_KEY_ENCODING = 'x25519-base64'

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
  // The last 32 bytes of the SPKI encoding are the raw key; the 12 before them
  // are a fixed RFC 8410 prefix. node has no raw export, and the app's own
  // identity module takes the same slice.
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  return {
    handle,
    publicKey: raw.toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

/**
 * The bytes of one member file, byte for byte what the app writes.
 *
 * Duplicated rather than imported because this harness is plain ESM and the
 * authority is TypeScript. The duplication is held honest by a test that parses
 * this output with the app's own parser.
 */
export function memberFileText(identity, addedAt = new Date().toISOString().slice(0, 10)) {
  return [
    '# teamree member',
    '#',
    '# Push access to this repository is what makes this membership: whoever can',
    '# add a key here is on the team, and whoever loses push access stops being',
    '# able to change it. There is no second list anywhere.',
    '#',
    '# This is the public half of an X25519 keypair. The private half never',
    '# leaves the machine that generated it and is never written to a repository.',
    '',
    `handle: ${identity.handle}`,
    `key: x25519 ${identity.publicKey}`,
    `added: ${addedAt}`,
    ''
  ].join('\n')
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
  await writeFile(path, memberFileText(identity))
  return path
}

/**
 * The public key out of one member file, or null if it does not hold exactly
 * one well-formed `key:` line. Mirrors the app's parser closely enough for the
 * harness's purposes; `tests/teamwork/harnessKeyFormat.test.ts` is what keeps
 * the two honest about the format itself.
 */
function readKeyLine(text) {
  const keys = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^key:\s*x25519\s+([A-Za-z0-9+/]{43}=)$/.exec(trimmed)
    if (match) keys.push(match[1])
  }
  return keys.length === 1 ? keys[0] : null
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
    const text = await readFile(join(repoPath, MEMBERS_DIR, name), 'utf8')
    const key = readKeyLine(text)
    // A file it cannot read is skipped rather than guessed at, matching the
    // app's parser: a guess here is a stranger in the roster.
    if (key !== null) members.push({ handle, publicKey: key })
  }
  return members
}
