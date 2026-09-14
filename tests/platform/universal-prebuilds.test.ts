// The half of the users nobody can test on.
//
// macOS ships as one universal artifact, so the same `.dmg` runs on Apple
// Silicon and on Intel. node-pty is a native module, and `node-gyp-build`
// resolves its binary from `process.arch` at run time — so a universal app that
// carries only one architecture's prebuild opens no terminal at all on the
// other, which for a terminal-shaped application is the whole of it.
//
// This cannot be caught downstream. `npm run release` packages on whichever Mac
// a maintainer cuts the release from — an Apple Silicon one, so far — and
// verifies the app there, where the arm64 binary is present and everything
// works; the Intel half would fail first on somebody else's Mac. And the pruning
// happens per-architecture during a build that electron-builder then merges, so
// the bug would look like a working build right up until it did not.

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// The hook is plain ESM because electron-builder loads it itself, from a
// config file, with no TypeScript in front of it.
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
  const cli = join(out, 'teamree.app', 'Contents', 'Resources', 'cli')
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, 'teamree'), '#!/bin/sh\n', { mode: 0o755 })
  return out
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
  // Both sub-builds, because the merge only works if the two trees agree — and
  // because whichever one dropped the other's binary would produce an app that
  // runs and cannot open a pane.
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
    // electron-builder runs this hook three times for a universal build: once
    // per architecture, and once more over the merged bundle with `arch`
    // reported as `universal`. There is no `darwin-universal` prebuild and
    // there never will be — asking for one failed the build after the merge had
    // already succeeded, which is the most expensive place to find out.
    //
    // What the third pass has to check is that both real prebuilds survived the
    // merge, since that is exactly what the merge could have broken.
    const out = await packagedApp()
    await afterPack(context(out, ARCH.universal))
    expect(await prebuildsIn(out)).toEqual(['darwin-arm64', 'darwin-x64'])
  })

  it('still fails the merged bundle when an architecture did not survive', async () => {
    // The check above is only worth having if it can still fail. A universal
    // app missing one side opens no terminal on those Macs, and says nothing
    // about it until somebody tries.
    const out = await packagedApp()
    await rm(join(prebuildsDir(out), 'darwin-x64'), { recursive: true, force: true })
    await expect(afterPack(context(out, ARCH.universal))).rejects.toThrow('darwin-x64')
  })

  it('still drops the platforms this artifact is not for', async () => {
    // The pruning is worth ~58 MB across four platforms and is the reason the
    // hook exists; keeping both architectures must not turn into keeping
    // everything.
    const out = await packagedApp()
    await afterPack(context(out, ARCH.arm64))
    const kept = await prebuildsIn(out)
    expect(kept).not.toContain('win32-x64')
    expect(kept).not.toContain('linux-x64')
  })
})
