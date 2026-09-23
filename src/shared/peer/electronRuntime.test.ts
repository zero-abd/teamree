// Node links OpenSSL and Electron links BoringSSL, which has no
// `chacha20-poly1305`; `primitives.ts` once threw "Unknown cipher" on every
// shipped build while all tests stayed green. This spawns the real Electron
// binary to prove the cipher path there; `npm run smoke` repeats it in a real main process.

import { execFile } from 'node:child_process'
import { createCipheriv, createHash, getCiphers } from 'node:crypto'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// Plain ESM, because Electron runs them too and has no TypeScript loader.
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
      // Electron-as-Node: the main process's BoringSSL, no display server needed.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 8 * 1024 * 1024
    })

    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as CheckResult

    expect(result.failures).toEqual([])
    expect(result.runtime).toMatch(/^electron /)
    // Keeps the test honest: if Electron ever ships `chacha20-poly1305` natively
    // this goes red, and the test no longer proves what it says it proves.
    expect(result.nativeChaCha).toBe(false)
  }, 120_000)

  it('completes the same checks under plain Node, which the acceptance suite uses', async () => {
    // The runtime also runs headlessly under Node; in-process, since that is the runtime already running.
    const result = (await runPeerCheck(bundleDir)) as CheckResult
    expect(result.failures).toEqual([])
    expect(result.runtime).toMatch(/^node /)
    expect(result.nativeChaCha).toBe(true)
  }, 60_000)

  it('pins its known answers to the cipher OpenSSL implements, not to itself', () => {
    // The frozen ciphertexts are recomputed against Node's native ChaCha20-Poly1305,
    // the implementation the published vectors in `noiseVectors.test.ts` validate.
    expect(getCiphers()).toContain('chacha20-poly1305')

    const answers = AEAD_KNOWN_ANSWERS as KnownAnswers
    const key = Buffer.from(answers.key, 'hex')
    const ad = Buffer.from(answers.associatedData, 'hex')
    const plaintext = Buffer.from(answers.plaintext, 'hex')

    // Derived, so the constants can be regenerated from this description alone.
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
