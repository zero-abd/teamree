// The test that would have caught it.
//
// Every other file in this directory tests the peer library under vitest, which
// is plain Node. The product is Electron. Node links OpenSSL and Electron links
// BoringSSL, and the two do not offer the same ciphers: `getCiphers()` returns
// 130 names under Node 24 and 28 under Electron 38, and `chacha20-poly1305` —
// the cipher this library's whole suite is named after — is in the first list
// and not the second.
//
// So `primitives.ts` threw "Unknown cipher" on the first handshake of every
// shipped build while 1803 tests stayed green, and teamwork was dead in the
// product for as long as nobody tried it by hand.
//
// This spawns the real Electron binary, hands it the real peer library, and
// makes it prove the cipher path works there. It runs under `npm test` like
// everything else, so it cannot be the check somebody forgot to run — and it
// asserts the child reported *no* native ChaCha, so a future change that
// accidentally runs it under Node fails instead of passing vacuously.
//
// The same check also runs inside a genuine Electron main process during
// `npm run smoke`; see `scripts/smoke.mjs`. Electron-as-Node and Electron's main
// process share one crypto implementation, so this is the cheap one that gates
// every run and that is the faithful one that gates a build.

import { execFile } from 'node:child_process'
import { createCipheriv, createHash, getCiphers } from 'node:crypto'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Plain ESM helpers rather than TypeScript, because the second thing that runs
// them is Electron, which has no TypeScript loader. See `peer-bundle.mjs`.
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { AEAD_KNOWN_ANSWERS, runPeerCheck } from '../../../scripts/electron-peer-check.mjs'
// @ts-expect-error -- see above.
import { buildPeerBundle } from '../../../scripts/peer-bundle.mjs'

const run = promisify(execFile)

type CheckResult = { runtime: string; nativeChaCha: boolean; failures: string[] }

type KnownAnswers = {
  key: string
  associatedData: string
  plaintext: string
  ciphertexts: { nonce: string; hex: string }[]
}

const CHECK_SCRIPT = fileURLToPath(new URL('../../../scripts/electron-peer-check.mjs', import.meta.url))

let bundleDir = ''

beforeAll(async () => {
  bundleDir = (await buildPeerBundle()) as string
}, 60_000)

afterAll(() => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true })
})

describe('the peer library in the runtime that actually ships', () => {
  it('completes a handshake and matches the published vectors under Electron', async () => {
    // `electron`'s main export is the path to its own binary.
    const binary = ((await import('electron')) as unknown as { default: string }).default

    const { stdout } = await run(binary, [CHECK_SCRIPT, bundleDir], {
      // Electron-as-Node: the same V8 and the same BoringSSL as the main
      // process, with no window and no display server, so this runs on a
      // headless runner without xvfb in front of it.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 8 * 1024 * 1024
    })

    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as CheckResult

    expect(result.failures).toEqual([])
    expect(result.runtime).toMatch(/^electron /)
    // The assertion that keeps this test honest. If Electron ever ships
    // `chacha20-poly1305` natively this goes red, and the right answer is to
    // read the failure rather than delete it: the runtime will have moved, and
    // this test will no longer prove what it says it proves.
    expect(result.nativeChaCha).toBe(false)
  }, 120_000)

  it('completes the same checks under plain Node, which the acceptance suite uses', async () => {
    // The runtime also runs headlessly under Node, so "works in Electron" is
    // only half of it. In-process rather than spawned: the runtime under test
    // is the one already running.
    const result = (await runPeerCheck(bundleDir)) as CheckResult
    expect(result.failures).toEqual([])
    expect(result.runtime).toMatch(/^node /)
    expect(result.nativeChaCha).toBe(true)
  }, 60_000)

  it('pins its known answers to the cipher OpenSSL implements, not to itself', () => {
    // `electron-peer-check.mjs` carries frozen ciphertexts, and a frozen
    // ciphertext is only worth something if something outside this project
    // agrees with it. Here they are recomputed against Node's own native
    // ChaCha20-Poly1305 — which exists under vitest even though it does not
    // exist under Electron, and which is the implementation the thirty-eight
    // published vectors in `noiseVectors.test.ts` already validate.
    expect(getCiphers()).toContain('chacha20-poly1305')

    const answers = AEAD_KNOWN_ANSWERS as KnownAnswers
    const key = Buffer.from(answers.key, 'hex')
    const ad = Buffer.from(answers.associatedData, 'hex')
    const plaintext = Buffer.from(answers.plaintext, 'hex')

    // Derived rather than typed, so the constants can be regenerated from this
    // description alone rather than trusted because they are written down.
    expect(key).toEqual(createHash('sha256').update('teamree/peer/aead-known-answer/key', 'utf8').digest())
    expect(ad).toEqual(createHash('sha256').update('teamree/peer/aead-known-answer/associated-data', 'utf8').digest())

    for (const expected of answers.ciphertexts) {
      // Noise's nonce encoding: 32 zero bits, then the counter little-endian.
      const iv = Buffer.alloc(12)
      iv.writeBigUInt64LE(BigInt(expected.nonce), 4)
      const cipher = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 })
      cipher.setAAD(ad, { plaintextLength: plaintext.length })
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
      expect(Buffer.concat([body, cipher.getAuthTag()]).toString('hex')).toBe(expected.hex)
    }
  })
})
