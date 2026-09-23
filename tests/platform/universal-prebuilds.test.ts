// The universal .dmg must carry node-pty prebuilds for both arm64 and x64: `node-gyp-build` picks by
// `process.arch`, and a release cut on Apple Silicon would never notice the Intel half missing.

import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// Plain ESM, loaded by electron-builder itself.
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import afterPack from '../../scripts/afterpack.mjs'

/** electron-builder's Arch enum, which is what a real context carries. */
const ARCH = { x64: 1, arm64: 3, universal: 4 } as const

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'] as const

/**
 * A packaged tree with just enough in it for the hook to accept: node-pty
 * unpacked, a prebuild per platform, and the two executables it insists on.
 */
async function packagedApp(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), 'teamree-afterpack-'))
  const pty = join(out, 'teamree.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  for (const platform of PLATFORMS) {
    const dir = join(pty, 'prebuilds', platform)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pty.node'), platform, 'utf8')
    await writeFile(join(dir, 'spawn-helper'), '#!/bin/sh\n', { mode: 0o755 })
  }
  // Written without the executable bit, so the test proves the hook sets it.
  for (const [dir, name] of [
    ['cli', 'teamree'],
    ['relay', 'teamree-relay']
  ]) {
    const at = join(out, 'teamree.app', 'Contents', 'Resources', dir as string)
    await mkdir(at, { recursive: true })
    await writeFile(join(at, name as string), '#!/bin/sh\n', { mode: 0o644 })
  }
  return out
}

/** The permission bits on one path under the packaged Resources directory. */
async function modeOf(appOutDir: string, ...segments: string[]): Promise<number> {
  const at = join(appOutDir, 'teamree.app', 'Contents', 'Resources', ...segments)
  return (await stat(at)).mode & 0o777
}

const context = (appOutDir: string, arch: number): Parameters<typeof afterPack>[0] =>
  ({
    appOutDir,
    electronPlatformName: 'darwin',
    arch,
    packager: { appInfo: { productFilename: 'teamree' } }
  }) as never

function prebuildsDir(appOutDir: string): string {
  return join(
    appOutDir,
    'teamree.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds'
  )
}

async function prebuildsIn(appOutDir: string): Promise<string[]> {
  return (await readdir(prebuildsDir(appOutDir))).sort()
}

describe('what a universal macOS build keeps', () => {
  // Both sub-builds must agree for the merge to work.
  for (const [name, arch] of [
    ['the Apple Silicon half', ARCH.arm64],
    ['the Intel half', ARCH.x64]
  ] as const) {
    it(`keeps node-pty for both architectures when packing ${name}`, async () => {
      const out = await packagedApp()
      await afterPack(context(out, arch))
      expect(await prebuildsIn(out)).toEqual(['darwin-arm64', 'darwin-x64'])
    })
  }

  it('accepts the merged bundle, where the architecture is not one', async () => {
    // The hook runs a third time over the merged bundle with `arch` = universal; there is no
    // darwin-universal prebuild, so it must check that both real ones survived the merge.
    const out = await packagedApp()
    await afterPack(context(out, ARCH.universal))
    expect(await prebuildsIn(out)).toEqual(['darwin-arm64', 'darwin-x64'])
  })

  it('still fails the merged bundle when an architecture did not survive', async () => {
    // The check above must still be able to fail.
    const out = await packagedApp()
    await rm(join(prebuildsDir(out), 'darwin-x64'), { recursive: true, force: true })
    await expect(afterPack(context(out, ARCH.universal))).rejects.toThrow('darwin-x64')
  })

  // The hook fixed the CLI launcher's exec bit but not the relay launcher's; a 0644 one is "permission
  // denied" in a pane and a dead Teamwork button.
  it('puts the executable bit back on both shipped launchers, not just the CLI', async () => {
    const out = await packagedApp()
    expect(await modeOf(out, 'cli', 'teamree')).toBe(0o644)
    expect(await modeOf(out, 'relay', 'teamree-relay')).toBe(0o644)

    await afterPack(context(out, ARCH.arm64))

    expect(await modeOf(out, 'cli', 'teamree')).toBe(0o755)
    expect(await modeOf(out, 'relay', 'teamree-relay')).toBe(0o755)
  })

  // A missing relay launcher fails the build, not a user.
  it('refuses a package the relay launcher never reached', async () => {
    const out = await packagedApp()
    await rm(join(out, 'teamree.app', 'Contents', 'Resources', 'relay'), { recursive: true, force: true })
    await expect(afterPack(context(out, ARCH.arm64))).rejects.toThrow('relay launcher is missing')
  })

  it('still drops the platforms this artifact is not for', async () => {
    // Pruning saves ~58 MB; keeping both architectures must not mean keeping everything.
    const out = await packagedApp()
    await afterPack(context(out, ARCH.arm64))
    const kept = await prebuildsIn(out)
    expect(kept).not.toContain('win32-x64')
    expect(kept).not.toContain('linux-x64')
  })
})
