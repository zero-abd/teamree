// The member file format, both directions.
//
// This file is committed, so it is read in a diff far more often than it is
// read by the parser below. That is what the format is for: a short header
// saying what the thing is, then three labelled lines, so somebody reviewing a
// pull request can see at a glance that a person was added and which key they
// were added with.
//
// The parser is forgiving about everything that does not change whose key it
// is — blank lines, comments, ordering, stray whitespace, labels it has never
// heard of — and unforgiving about everything that does. A file it cannot read
// exactly is refused, never guessed at, because a guess here is a stranger in
// the roster.

import { sanitiseHandle } from './handle'

/** Where a project keeps its roster, relative to the checkout root. */
export const MEMBERS_DIR_SEGMENTS = ['.teamree', 'members'] as const

export const MEMBER_FILE_SUFFIX = '.pub'

/** The only key type this version writes, and the only one it accepts. */
export const KEY_ALGORITHM = 'x25519'

/** Base64 of 32 bytes: 43 characters of payload and one pad. */
const PUBLIC_KEY_BASE64 = /^[A-Za-z0-9+/]{43}=$/

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type MemberFileContent = {
  handle: string
  /** Base64 of the 32-byte X25519 public key. */
  publicKey: string
  /** ISO 8601 date, `YYYY-MM-DD`. */
  addedAt: string
}

export type MemberFileParse = { ok: true; value: MemberFileContent } | { ok: false; reason: string }

export function formatMemberFile(content: MemberFileContent): string {
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
    `handle: ${content.handle}`,
    `key: ${KEY_ALGORITHM} ${content.publicKey}`,
    `added: ${content.addedAt}`,
    ''
  ].join('\n')
}

export function parseMemberFile(text: string): MemberFileParse {
  const fields = new Map<string, string>()

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator === -1) return { ok: false, reason: `line ${index + 1} is neither a comment nor a "label: value"` }
    const label = trimmed.slice(0, separator).trim().toLowerCase()
    // A label appearing twice is the one shape of damage that would otherwise
    // resolve silently, and whichever of the two won would be a coin toss over
    // who this key belongs to.
    //
    // Quoted through `quote`, because everything on this line came out of a
    // committed file that anybody with push access wrote, and this reason
    // travels to the renderer in a `members.list` result. A 200,000-character
    // label should cost its author a truncated message, not everyone else a
    // 200,000-character row.
    if (fields.has(label)) return { ok: false, reason: `"${quote(label)}" appears more than once` }
    fields.set(label, trimmed.slice(separator + 1).trim())
  }

  const handle = sanitiseHandle(fields.get('handle'))
  if (fields.get('handle') === undefined) return { ok: false, reason: 'no "handle" line' }
  if (handle === undefined || handle !== fields.get('handle')) {
    return { ok: false, reason: 'the handle is not a name teamree would have written' }
  }

  const rawKey = fields.get('key')
  if (rawKey === undefined) return { ok: false, reason: 'no "key" line' }
  const publicKey = readKey(rawKey)
  if (publicKey === undefined) {
    return { ok: false, reason: `the key is not "${KEY_ALGORITHM} <32 bytes of base64>"` }
  }

  const addedAt = fields.get('added')
  if (addedAt === undefined) return { ok: false, reason: 'no "added" line' }
  if (!ISO_DATE.test(addedAt)) return { ok: false, reason: 'the added date is not YYYY-MM-DD' }

  return { ok: true, value: { handle, publicKey, addedAt } }
}

/**
 * The longest a quoted scrap of a committed file may be when it is echoed back
 * in a problem. Long enough to recognise a typo in, short enough that a row is
 * a row.
 */
export const MAX_QUOTED_LENGTH = 60

/**
 * One piece of attacker-controlled text, made safe to put in a message.
 *
 * Everything in a member file was written by somebody with push access, and
 * problems travel to the renderer in a `members.list` result. Truncating is not
 * politeness; it is the difference between a bad file costing its author a
 * clipped message and costing every reader a screen of one.
 */
export function quote(raw: string): string {
  // Control characters and newlines would break out of the one line a problem
  // is rendered on, which is its own small kind of forgery.
  // oxlint-disable-next-line no-control-regex -- matching them is the point
  const flattened = raw.replace(/[\u0000-\u001f\u007f]/g, ' ')
  return flattened.length <= MAX_QUOTED_LENGTH ? flattened : `${flattened.slice(0, MAX_QUOTED_LENGTH)}…`
}

/** True for a base64 string that really is 32 bytes and really is canonical. */
export function isPublicKey(value: string): boolean {
  if (!PUBLIC_KEY_BASE64.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32) return false
  // X25519 ignores the top bit of the last byte — RFC 7748 masks it before the
  // scalar multiplication — so `K` and `K | 2^255` are the same identity spelled
  // two ways. Every comparison in this codebase is on the base64 string, so two
  // spellings of one key would walk straight past the duplicate-key check and
  // arrive as two members with, as far as the handshake is concerned, the same
  // key. No conforming encoder produces one: a public key is a field element
  // below 2^255 - 19, so this bit is always clear in anything real.
  if ((decoded[31] as number) & 0x80) return false
  // base64 leaves two unused bits in the last character, so a string can match
  // the shape, decode to the right length, and still not be what an encoder
  // would ever produce. Re-encoding is the cheapest way to insist on one
  // spelling per key, which matters because keys are compared as strings.
  return decoded.toString('base64') === value
}

function readKey(raw: string): string | undefined {
  const space = raw.indexOf(' ')
  if (space === -1) return undefined
  if (raw.slice(0, space).toLowerCase() !== KEY_ALGORITHM) return undefined
  const encoded = raw.slice(space + 1).trim()
  return isPublicKey(encoded) ? encoded : undefined
}
