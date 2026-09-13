// Attribution is the whole mitigation.
//
// `docs/teamwork.md` grants every member the ability to run arbitrary commands
// on every other member's machine, once that member allows it — and everything
// that makes that survivable names a person. The prompt asks about a handle;
// the pane says who is watching; typing is attributed live; every remote write
// is logged with who and when. All four of those name a person by their handle,
// and a handle comes from exactly one place — the name of a file in
// `.teamree/members`. A prompt that named the wrong person would be worse than
// no prompt, because it would be answered.
//
// So "one handle names one key, and one key names one person" is not a tidiness
// property of the roster reader. It is the load-bearing part of the only
// defence this feature has, and these are the ways it was forgeable.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMemberFile, isPublicKey, MAX_QUOTED_LENGTH, MEMBERS_DIR_SEGMENTS, quote } from './memberFile'
import { readRoster } from './roster'

/**
 * Whether two names differing only in case are two files here.
 *
 * They are on Linux and are not on macOS, and the forgery below is shaped by
 * that: where the filesystem folds them, an attacker cannot add a second file
 * at all — they can only overwrite the first, which git shows as a change to
 * the member's own key rather than as an innocuous new one.
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
    // The forgery: the suffix used to be matched case-insensitively while the
    // stem was matched case-sensitively, so `bob.PUB` yielded the stem "bob",
    // passed the handle check, and was accepted as a fully authorised member
    // called bob — with somebody else's key in it.
    const root = await projectWithFiles({ 'bob.pub': member('bob', KEY_A), 'bob.PUB': member('bob', KEY_B) })
    const roster = await readRoster(root)

    // One member named bob either way, and never the intruder's key under his
    // name — which is the property that matters. What differs is what the
    // attacker was even able to write.
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

    // One file. There was never a `bob.PUB` to refuse: the second write landed
    // on `bob.pub` itself. The attacker gains nothing they could not have got by
    // editing the file directly, and loses the disguise — a changed key in an
    // existing member's file is the conspicuous version of this.
    expect(roster.entries[0]?.publicKey).toBe(KEY_B)
    expect(roster.problems).toEqual([])
  })

  it('reports a wrong-case suffix rather than ignoring the file in silence', async () => {
    // Listed case-insensitively so it is seen, matched exactly so it is never a
    // member. Silently skipping it would leave somebody wondering why they are
    // not on the team.
    const root = await projectWithFiles({ 'ana.PUB': member('ana', KEY_A) })
    const roster = await readRoster(root)

    expect(roster.entries).toEqual([])
    expect(roster.problems[0]?.reason).toContain('.pub')
  })

  it('still lists the good members when a bad name is beside them', async () => {
    // The governing rule of this reader: one bad file costs one member, never
    // the list.
    const root = await projectWithFiles({ 'ana.pub': member('ana', KEY_A), 'bob.PUB': member('bob', KEY_B) })
    const roster = await readRoster(root)
    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ana'])
  })
})

describe('one handle, one person', () => {
  // There is deliberately no test here for the duplicate-handle guard in
  // `roster.ts`. With an exact suffix and a canonical stem it is unreachable —
  // two files in one directory cannot produce one stem — so any test of it
  // would have to reach past the rules it guards, and would then be asserting
  // that a line of code exists rather than that a property holds. It is kept in
  // the reader because the property is load-bearing and a later change to
  // either filename rule could quietly remove it; the test that would catch
  // that is the one above, which is about the filename rules themselves.

  it('refuses a second entry for a key already claimed, naming who has it', async () => {
    const root = await projectWithFiles({ 'ana.pub': member('ana', KEY_A), 'bob.pub': member('bob', KEY_A) })
    const roster = await readRoster(root)

    expect(roster.entries.map((entry) => entry.handle)).toEqual(['ana'])
    expect(roster.problems[0]?.reason).toContain('same key')
  })
})

describe('one key, one spelling', () => {
  it('refuses a key whose ignored top bit is set, because it is a second spelling', async () => {
    // X25519 masks the top bit of the last byte before the scalar
    // multiplication, so `K` and `K | 2^255` are one identity written two ways.
    // Every comparison in this codebase is on the base64 string, so the second
    // spelling would walk past the duplicate-key check and arrive as a separate
    // member holding, as far as any handshake is concerned, the same key.
    const raw = Buffer.alloc(32, 1)
    const masked = Buffer.from(raw)
    masked[31] = (masked[31] as number) | 0x80

    expect(isPublicKey(raw.toString('base64'))).toBe(true)
    expect(isPublicKey(masked.toString('base64'))).toBe(false)
  })

  it('accepts every key a real generator produces', async () => {
    // The rejection above is only safe because a conforming public key is a
    // field element below 2^255 - 19, so that bit is always clear in anything
    // real. Checked rather than assumed.
    const { generateStaticKeyPair } = await import('../../shared/peer')
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(isPublicKey(Buffer.from(generateStaticKeyPair().publicKey).toString('base64'))).toBe(true)
    }
  })
})

describe('what a bad file is allowed to cost the people reading it', () => {
  it('caps a label it echoes back, rather than passing a screenful to the window', async () => {
    // Everything in a member file was written by somebody with push access, and
    // a problem travels to the renderer in a `members.list` result.
    const label = 'x'.repeat(200_000)
    const root = await projectWithFiles({ 'ana.pub': `${label}: one\n${label}: two\n` })
    const roster = await readRoster(root)

    const reason = roster.problems[0]?.reason ?? ''
    expect(reason).toContain('appears more than once')
    expect(reason.length).toBeLessThan(MAX_QUOTED_LENGTH + 60)
  })

  it('flattens control characters, which would otherwise break out of the line', () => {
    // A reason is rendered on one line. A label carrying an escape sequence or
    // a newline could paint whatever it liked around itself, which is its own
    // small kind of forgery in a feature whose defence is what the screen says.
    const noisy = 'a\u0007b\u001b[31mc\nd'
    // The escape is defused, so what is left is inert text on one line. The
    // bracket and the digits stay, and should: they are only letters once the
    // ESC that made them a command is gone.
    expect(quote(noisy)).toBe('a b [31mc d')
    // oxlint-disable-next-line no-control-regex -- matching them is the point
    expect(quote(noisy)).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})
