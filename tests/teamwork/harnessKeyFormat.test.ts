// The harness and the app must write the same member file.
//
// They cannot share code: the harness is plain ESM so it can run without a
// build step, and the format lives in TypeScript. So the format is written
// twice, and this is what stops the two copies drifting — which they already
// did once. The harness was built before milestone A landed, guessed SPKI PEM
// because the design fixed the path and the algorithm but never the encoding,
// and guessed wrong. A harness that mints keys the app cannot read passes its
// own tests while proving nothing.

import { describe, expect, it } from 'vitest'
// Plain ESM on purpose, and the reason is the subject of this file: the harness
// has to run without a build step, which is why the format is written twice.
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { generateIdentity, memberFileText } from '../../scripts/teamwork/identity.mjs'
import { formatMemberFile, parseMemberFile } from '../../src/main/teamwork/memberFile'

describe('the harness writes what the app reads', () => {
  it('produces a member file the app parses', () => {
    const identity = generateIdentity('ana')
    const parsed = parseMemberFile(memberFileText(identity, '2026-09-13'))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.handle).toBe('ana')
    expect(parsed.value.publicKey).toBe(identity.publicKey)
  })

  // Byte-for-byte, not merely parseable: a file that parses but reviews
  // differently in a diff is still two formats.
  it('produces the same bytes the app would', () => {
    const identity = generateIdentity('ana')

    expect(memberFileText(identity, '2026-09-13')).toBe(
      formatMemberFile({ handle: 'ana', publicKey: identity.publicKey, addedAt: '2026-09-13' })
    )
  })

  // The app's parser requires base64 of exactly 32 bytes, so an encoding change
  // in the harness fails here rather than at the first handshake.
  it('mints a key of the size the format allows', () => {
    expect(Buffer.from(generateIdentity('ana').publicKey, 'base64')).toHaveLength(32)
  })
})
