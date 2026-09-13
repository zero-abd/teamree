// The endpoint the runtime listens on, for all three platforms.
//
// Unix domain sockets are bound by a fixed-size struct whose limit is counted in
// bytes, not characters, and Windows named pipes are not files at all. Both
// rules are asserted purely; the byte limit is then confirmed against the real
// kernel wherever there is one.

import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { endpointKey, fitsUnixSocketPath, isPipeEndpoint, resolveEndpoint } from '../../src/main/runtime/socketEndpoint'

/** A profile directory spelled in a script where every character is 3 bytes. */
const CJK_USER_DATA_DIR = `/home/${'用户'.repeat(20)}/.config/teamree`

describe('resolveEndpoint on Windows', () => {
  it('names a pipe in the kernel namespace, never a file', () => {
    const endpoint = resolveEndpoint('C:\\Users\\Abd\\AppData\\Roaming\\teamree', 'win32')
    expect(endpoint).toBe(`\\\\.\\pipe\\teamree-${endpointKey('C:\\Users\\Abd\\AppData\\Roaming\\teamree')}`)
    expect(isPipeEndpoint(endpoint)).toBe(true)
  })

  it('stays a legal pipe name however long or exotic the user data dir is', () => {
    const endpoint = resolveEndpoint(`C:\\Users\\${'ы'.repeat(200)}\\AppData\\Roaming\\teamree`, 'win32')
    expect(isPipeEndpoint(endpoint)).toBe(true)
    // A pipe name may not contain a backslash after the \\.\pipe\ prefix.
    expect(endpoint.slice('\\\\.\\pipe\\'.length)).not.toContain('\\')
    expect(endpoint.length).toBeLessThan(256)
  })

  it('gives two installs two pipes', () => {
    expect(resolveEndpoint('C:\\a\\teamree', 'win32')).not.toBe(resolveEndpoint('C:\\b\\teamree', 'win32'))
  })
})

describe('resolveEndpoint on unix', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`keeps a short user data dir in place on ${platform}`, () => {
      const endpoint = resolveEndpoint('/home/abd/.config/teamree', platform, { tmpDir: '/tmp' })
      expect(endpoint).toBe('/home/abd/.config/teamree/runtime.sock')
      expect(isPipeEndpoint(endpoint)).toBe(false)
    })

    it(`falls back to the temp dir when the user data dir is too deep on ${platform}`, () => {
      const deep = `/home/abd/${'nested/'.repeat(20)}teamree`
      const endpoint = resolveEndpoint(deep, platform, { tmpDir: '/tmp' })
      expect(endpoint).toBe(`/tmp/teamree-${endpointKey(deep)}.sock`)
      expect(fitsUnixSocketPath(endpoint)).toBe(true)
    })
  }

  // The defect: the limit was compared against the JavaScript string length, so
  // a profile directory in any non-Latin script sailed past a check measured in
  // characters and then failed to bind, counted in bytes, at startup.
  it('measures the limit in bytes, not characters', () => {
    expect(CJK_USER_DATA_DIR.length).toBeLessThan(92)
    expect(Buffer.byteLength(CJK_USER_DATA_DIR)).toBeGreaterThan(104)

    const endpoint = resolveEndpoint(CJK_USER_DATA_DIR, 'linux', { tmpDir: '/tmp' })
    expect(endpoint).toBe(`/tmp/teamree-${endpointKey(CJK_USER_DATA_DIR)}.sock`)
    expect(fitsUnixSocketPath(endpoint)).toBe(true)
  })

  it('leaves the temp dir behind too when TMPDIR is itself long', () => {
    const longTmp = `/var/folders/${'x'.repeat(120)}/T`
    const endpoint = resolveEndpoint(`/home/${'z'.repeat(120)}/teamree`, 'darwin', { tmpDir: longTmp })
    expect(endpoint.startsWith('/tmp/teamree-')).toBe(true)
    expect(fitsUnixSocketPath(endpoint)).toBe(true)
  })

  it('never returns a path the kernel would reject', () => {
    for (const dir of [CJK_USER_DATA_DIR, '/home/abd/.config/teamree', `/home/${'q'.repeat(300)}/teamree`]) {
      expect(fitsUnixSocketPath(resolveEndpoint(dir, 'linux', { tmpDir: '/tmp' }))).toBe(true)
    }
  })
})

describe('isPipeEndpoint', () => {
  it('recognizes both pipe prefixes and nothing else', () => {
    expect(isPipeEndpoint('\\\\.\\pipe\\teamree-abc')).toBe(true)
    expect(isPipeEndpoint('\\\\?\\pipe\\teamree-abc')).toBe(true)
    expect(isPipeEndpoint('/tmp/teamree.sock')).toBe(false)
    expect(isPipeEndpoint('C:\\temp\\teamree.sock')).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('the kernel underneath', () => {
  const bind = (socketPath: string): Promise<string> =>
    new Promise((resolve) => {
      const server = createServer()
      server.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
      server.listen(socketPath, () => server.close(() => resolve('ok')))
    })

  /** A directory whose path is at least `bytes` long. */
  const deepDirectory = (bytes: number): string => {
    let current = mkdtempSync(path.join(tmpdir(), 'sockdir-'))
    while (Buffer.byteLength(current) < bytes) {
      current = path.join(current, 'wwwwwwwwww')
      mkdirSync(current)
    }
    return current
  }

  /** What a kernel that enforces sun_path says when a path overruns it. */
  const TOO_LONG = new Set(['ENAMETOOLONG', 'EINVAL'])

  /**
   * Whether this kernel enforces sun_path at all. Every real one does, which is
   * the whole reason the limit exists — but a sandboxed filesystem need not:
   * some accept the path and truncate it internally, which shows up as an
   * unrelated code (two distinct long paths collide into EADDRINUSE) rather
   * than a refusal. Anything but a genuine length error means the rejection
   * below has nothing to prove, not that our limit is wrong.
   */
  let enforcesSunPath = true
  beforeAll(async () => {
    enforcesSunPath = TOO_LONG.has(await bind(path.join(deepDirectory(200), 'probe.sock')))
  })

  it('accepts what fitsUnixSocketPath allows', async () => {
    const socketPath = path.join(mkdtempSync(path.join(tmpdir(), 'sock-')), 'runtime.sock')
    expect(fitsUnixSocketPath(socketPath)).toBe(true)
    expect(await bind(socketPath)).toBe('ok')
  })

  it('rejects a path that is short in characters but long in bytes', async (ctx) => {
    // 30 CJK characters are 90 bytes: under any character-counted limit, over
    // the byte-counted one the kernel actually enforces.
    const socketPath = path.join(deepDirectory(40), `${'字'.repeat(30)}.sock`)
    expect(socketPath.length).toBeLessThan(105)
    expect(fitsUnixSocketPath(socketPath)).toBe(false)
    if (!enforcesSunPath) ctx.skip('this kernel does not enforce sun_path')
    expect(await bind(socketPath)).not.toBe('ok')
  })
})
