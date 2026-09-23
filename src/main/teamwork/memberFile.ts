// The member file format, both directions. Read in a diff far more often than by the parser, hence a
// header and three labelled lines. The parser is forgiving about everything that does not change whose
// key it is, and refuses rather than guesses at everything that does: a guess here is a stranger in the roster.

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
    // A label appearing twice would otherwise resolve silently, a coin toss over whose key this is.
    // Quoted through `quote`: anybody with push access wrote this line, and the reason reaches the renderer.
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

/** The longest a quoted scrap of a committed file may be in a problem: enough to recognise a typo in. */
export const MAX_QUOTED_LENGTH = 60

/**
 * One piece of attacker-controlled text, made safe to put in a message: a bad file should cost its author
 * a clipped message, not every reader a screen of one.
 */
export function quote(raw: string): string {
  // Control characters and newlines would break out of the one line a problem is rendered on.
  // oxlint-disable-next-line no-control-regex -- matching them is the point
  const flattened = raw.replace(/[\u0000-\u001f\u007f]/g, ' ')
  return flattened.length <= MAX_QUOTED_LENGTH ? flattened : `${flattened.slice(0, MAX_QUOTED_LENGTH)}…`
}

/** True for a base64 string that really is 32 bytes and really is canonical. */
export function isPublicKey(value: string): boolean {
  if (!PUBLIC_KEY_BASE64.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32) return false
  // RFC 7748 masks the top bit of the last byte, so `K` and `K | 2^255` are one identity spelled two
  // ways, and comparisons here are on the base64 string. No conforming encoder sets it: a public key
  // is a field element below 2^255 - 19.
  if ((decoded[31] as number) & 0x80) return false
  // base64 leaves two unused bits in the last character; re-encoding insists on one spelling per key,
  // which matters because keys are compared as strings.
  return decoded.toString('base64') === value
}

function readKey(raw: string): string | undefined {
  const space = raw.indexOf(' ')
  if (space === -1) return undefined
  if (raw.slice(0, space).toLowerCase() !== KEY_ALGORITHM) return undefined
  const encoded = raw.slice(space + 1).trim()
  return isPublicKey(encoded) ? encoded : undefined
}
