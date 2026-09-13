import { describe, expect, it } from 'vitest'
import { formatMemberFile, isPublicKey, parseMemberFile } from './memberFile'

const KEY = 'PkQtFYttlX7oLD8c/tYpNlHWLIflye3t6tMGm0I4iRk='

const file = (...lines: string[]): string => `${lines.join('\n')}\n`

describe('the member file as written', () => {
  it('round-trips through its own parser', () => {
    const content = { handle: 'ada', publicKey: KEY, addedAt: '2026-09-13' }

    const parsed = parseMemberFile(formatMemberFile(content))

    expect(parsed).toEqual({ ok: true, value: content })
  })

  it('says what it is and what it costs, for whoever reads the diff', () => {
    const text = formatMemberFile({ handle: 'ada', publicKey: KEY, addedAt: '2026-09-13' })

    expect(text).toContain('# teamree member')
    expect(text).toMatch(/push access to this repository/i)
    // Nobody reading this file should have to wonder where the other half is.
    expect(text).toMatch(/private half never\n# leaves the machine/i)
  })
})

describe('reading a member file', () => {
  it('accepts a file a human has tidied: reordered, commented, spaced', () => {
    const parsed = parseMemberFile(
      file('added: 2026-09-13', '', '# added at the offsite', `key:  x25519   ${KEY}  `, 'handle: ada')
    )

    expect(parsed).toEqual({ ok: true, value: { handle: 'ada', publicKey: KEY, addedAt: '2026-09-13' } })
  })

  it('ignores a label it has never heard of, so a later version can add one', () => {
    const parsed = parseMemberFile(file('handle: ada', `key: x25519 ${KEY}`, 'added: 2026-09-13', 'relay: wss://ours'))

    expect(parsed.ok).toBe(true)
  })

  it('refuses a file that names its owner twice rather than picking one', () => {
    const parsed = parseMemberFile(file('handle: ada', 'handle: mallory', `key: x25519 ${KEY}`, 'added: 2026-09-13'))

    expect(parsed).toEqual({ ok: false, reason: '"handle" appears more than once' })
  })

  it.each([
    ['no "handle" line', file(`key: x25519 ${KEY}`, 'added: 2026-09-13')],
    ['no "key" line', file('handle: ada', 'added: 2026-09-13')],
    ['no "added" line', file('handle: ada', `key: x25519 ${KEY}`)]
  ])('refuses a file missing a field it needs: %s', (reason, text) => {
    expect(parseMemberFile(text)).toEqual({ ok: false, reason })
  })

  it('refuses a key that is not an X25519 key of the right length', () => {
    const short = parseMemberFile(file('handle: ada', 'key: x25519 c2hvcnQ=', 'added: 2026-09-13'))
    const wrongAlgorithm = parseMemberFile(file('handle: ada', `key: ed25519 ${KEY}`, 'added: 2026-09-13'))

    expect(short.ok).toBe(false)
    expect(wrongAlgorithm.ok).toBe(false)
  })

  it('refuses a date that is not a date, so "added" can be trusted when it is read', () => {
    const parsed = parseMemberFile(file('handle: ada', `key: x25519 ${KEY}`, 'added: last tuesday'))

    expect(parsed).toEqual({ ok: false, reason: 'the added date is not YYYY-MM-DD' })
  })

  it('refuses a handle it would never have written, whatever the rest says', () => {
    const parsed = parseMemberFile(file('handle: ../../etc/passwd', `key: x25519 ${KEY}`, 'added: 2026-09-13'))

    expect(parsed.ok).toBe(false)
  })

  it('refuses prose, rather than reading half a file and calling it a member', () => {
    expect(parseMemberFile('hello there\n').ok).toBe(false)
  })
})

describe('recognising a public key', () => {
  it('insists on one spelling per key, since keys are compared as strings', () => {
    expect(isPublicKey(KEY)).toBe(true)
    // Same 32 bytes, unused trailing bits set: decodes identically, encodes
    // differently, and would look like a second member with the same key.
    expect(isPublicKey('PkQtFYttlX7oLD8c/tYpNlHWLIflye3t6tMGm0I4iRl=')).toBe(false)
    expect(isPublicKey('not base64 at all')).toBe(false)
  })
})
