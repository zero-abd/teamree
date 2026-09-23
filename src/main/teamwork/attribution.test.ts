// Attribution is the whole mitigation: the prompt, the watcher list, live typing and the write log all
// name a person by handle, and a handle comes from one place — a filename in `.teamree/members`.
// "One handle names one key, and one key names one person" is load-bearing; these are the ways it was forgeable.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMemberFile, isPublicKey, MAX_QUOTED_LENGTH, MEMBERS_DIR_SEGMENTS, quote } from './memberFile'
import { readRoster } from './roster'

/**
 * Whether two names differing only in case are two files here: they are on Linux and not on macOS.
 * Where the filesystem folds them, an attacker can only overwrite the first, which git shows as a key change.
 */
async function caseSensitiveFilesystem(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'teamree-case-'))
  await writeFile(join(probe, 'probe'), 'a', 'utf8')
  try {
    await readFile(join(probe, 'PROBE'), 'utf8')
    return false
  } catch {
    return true
  }
}

const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')

async function projectWithFiles(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamree-attribution-'))
  await mkdir(join(root, ...MEMBERS_DIR_SEGMENTS), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, ...MEMBERS_DIR_SEGMENTS, name), body, 'utf8')
  }
  return root
}

const member = (handle: string, publicKey: string): string =>
  formatMemberFile({ handle, publicKey, addedAt: '2026-01-01' })

describe('a member file has to be named exactly right', () => {
  it('refuses a key filed under a colleague’s name with a shouted suffix', async () => {
    // The forgery: a case-insensitive suffix with a case-sensitive stem let `bob.PUB` yield the stem
    // "bob" and be accepted as a fully authorised bob — with somebody else's key in it.
    const root = await projectWithFiles({ 'bob.pub': member('bob', KEY_A), 'bob.PUB': member('bob', KEY_B) })
    const roster = await readRoster(root)

    // One member named bob either way, and never the intruder's key under his name.
    expect(roster.entries).toHaveLength(1)
    expect(roster.entries[0]?.handle).toBe('bob')

    if (await caseSensitiveFilesystem()) {
      // Two files. The real bob keeps his key, and the squatted one is reported
      // rather than quietly ignored.
      expect(roster.entries[0]?.publicKey).toBe(KEY_A)
      expect(roster.problems).toHaveLength(1)
      expect(roster.problems[0]?.file).toContain('bob.PUB')
      return
    }

    // One file: the second write landed on `bob.pub` itself. The attacker gains nothing over editing
    // the file directly, and loses the disguise.
    expect(roster.entries[0]?.publicKey).toBe(KEY_B)
    expect(roster.problems).toEqual([])
  })

  it('reports a wrong-case suffix rather than ignoring the file in silence', async () => {
    // Listed case-insensitively so it is seen, matched exactly so it is never a member.
    const root = await projectWithFiles({ 'ana.PUB': member('ana', KEY_A) })
    const roster = await readRoster(root)

    expect(roster.entries).toEqual([])
    expect(roster.problems[0]?.reason).toContain('.pub')
  })

  it('still lists the good members when a bad name is beside them', async () => {
    // The governing rule of this reader: one bad file costs one member, never the list.
    const root = await projectWithFiles({ 'ana.pub': member('ana', KEY_A), 'bob.PUB': member('bob', KEY_B) })
    const roster = await readRoster(root)
    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ana'])
  })
})

describe('one handle, one person', () => {
  // Deliberately no test for the duplicate-handle guard in `roster.ts`: with an exact suffix and a
  // canonical stem it is unreachable, and it is kept only against a later change to either filename rule.

  it('refuses a second entry for a key already claimed, naming who has it', async () => {
    const root = await projectWithFiles({ 'ana.pub': member('ana', KEY_A), 'bob.pub': member('bob', KEY_A) })
    const roster = await readRoster(root)

    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ana'])
    expect(roster.problems[0]?.reason).toContain('same key')
  })
})

describe('one key, one spelling', () => {
  it('refuses a key whose ignored top bit is set, because it is a second spelling', async () => {
    // X25519 masks the top bit of the last byte, so `K` and `K | 2^255` are one identity written two
    // ways, and every comparison here is on the base64 string.
    const raw = Buffer.alloc(32, 1)
    const masked = Buffer.from(raw)
    masked[31] = (masked[31] as number) | 0x80

    expect(isPublicKey(raw.toString('base64'))).toBe(true)
    expect(isPublicKey(masked.toString('base64'))).toBe(false)
  })

  it('accepts every key a real generator produces', async () => {
    // Only safe because a conforming public key is a field element below 2^255 - 19. Checked, not assumed.
    const { generateStaticKeyPair } = await import('../../shared/peer')
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(isPublicKey(Buffer.from(generateStaticKeyPair().publicKey).toString('base64'))).toBe(true)
    }
  })
})

describe('what a bad file is allowed to cost the people reading it', () => {
  it('caps a label it echoes back, rather than passing a screenful to the window', async () => {
    // Everything in a member file was written by somebody with push access, and a problem reaches the renderer.
    const label = 'x'.repeat(200_000)
    const root = await projectWithFiles({ 'ana.pub': `${label}: one\n${label}: two\n` })
    const roster = await readRoster(root)

    const reason = roster.problems[0]?.reason ?? ''
    expect(reason).toContain('appears more than once')
    expect(reason.length).toBeLessThan(MAX_QUOTED_LENGTH + 60)
  })

  it('flattens control characters, which would otherwise break out of the line', () => {
    // A reason is rendered on one line; an escape sequence in a label could paint whatever it liked around itself.
    const noisy = 'a\u0007b\u001b[31mc\nd'
    // The bracket and the digits stay: they are only letters once the ESC that made them a command is gone.
    expect(quote(noisy)).toBe('a b [31mc d')
    // oxlint-disable-next-line no-control-regex -- matching them is the point
    expect(quote(noisy)).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})
