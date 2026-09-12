// electron-builder afterPack hook. Everything here is about node-pty, which is
// the one part of this app that a naive package quietly breaks:
//
//   * its native binary and its `spawn-helper` executable have to live outside
//     the asar archive (electron-builder.yml unpacks them),
//   * `spawn-helper` has to keep its executable bit, or every PTY spawn fails
//     with "posix_spawnp failed" — the same failure scripts/fix-pty-permissions.mjs
//     repairs in a source checkout,
//   * and its prebuilt binaries for four platforms are ~58 MB, of which one
//     platform's worth is useful in any given artifact.
//
// The hook fixes the first two and prunes the third, then verifies rather than
// assumes: a broken package here surfaces as a build failure, not as a terminal
// that never opens on a user's machine.
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** electron-builder's Arch enum, which arrives as a number. */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

function directorySize(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) total += directorySize(path)
    else if (entry.isFile()) total += statSync(path).size
  }
  return total
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch)
  const productName = context.packager.appInfo.productFilename

  const resources =
    electronPlatformName === 'darwin'
      ? join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources')

  const log = (message) => console.log(`  • afterPack ${electronPlatformName}-${arch}: ${message}`)

  // --- node-pty must be outside the asar -----------------------------------
  const pty = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  if (!existsSync(pty)) {
    throw new Error(
      `node-pty is not unpacked at ${pty}. Check the asarUnpack pattern in electron-builder.yml; ` +
        'PTY spawning cannot work from inside an asar archive.'
    )
  }

  // --- only this platform's prebuilt binaries are worth shipping ------------
  const prebuilds = join(pty, 'prebuilds')
  const wanted = `${electronPlatformName}-${arch}`
  let pruned = 0
  let prunedBytes = 0
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (entry === wanted) continue
      const path = join(prebuilds, entry)
      prunedBytes += directorySize(path)
      rmSync(path, { recursive: true, force: true })
      pruned += 1
    }
    if (pruned) log(`dropped ${pruned} foreign prebuild set(s), ${megabytes(prunedBytes)}`)
  }

  // --- the native module has to exist for the target -----------------------
  const prebuilt = join(prebuilds, wanted)
  const compiled = join(pty, 'build', 'Release')
  if (!existsSync(prebuilt) && !existsSync(compiled)) {
    // node-pty publishes no Linux prebuild: it is compiled by `npm install`, so
    // a Linux artifact packaged on macOS or Windows would ship no PTY at all.
    throw new Error(
      `node-pty has no binary for ${wanted}: neither ${prebuilt} nor ${compiled} exists. ` +
        `Package the ${electronPlatformName} artifact on ${electronPlatformName}, where npm install builds one.`
    )
  }
  const binaryDir = existsSync(prebuilt) ? prebuilt : compiled

  // --- spawn-helper has to stay executable ---------------------------------
  if (electronPlatformName !== 'win32') {
    const helper = join(binaryDir, 'spawn-helper')
    if (!existsSync(helper)) {
      throw new Error(`node-pty's spawn-helper is missing from ${binaryDir}; PTY spawning would fail at runtime.`)
    }
    const mode = statSync(helper).mode
    if (!(mode & 0o111)) {
      chmodSync(helper, 0o755)
      log('restored the executable bit on spawn-helper')
    }
    const verified = statSync(helper).mode
    if (!(verified & 0o111)) {
      throw new Error(`could not make ${helper} executable (mode ${(verified & 0o777).toString(8)}).`)
    }
    log(`spawn-helper ready at mode ${(verified & 0o777).toString(8)}`)
  }

  // --- the shipped CLI launcher has to stay executable ---------------------
  if (electronPlatformName !== 'win32') {
    const launcher = join(resources, 'cli', 'teamree')
    if (!existsSync(launcher)) throw new Error(`the CLI launcher is missing from ${launcher}.`)
    chmodSync(launcher, 0o755)
    log('CLI launcher installed at resources/cli/teamree')
  }

  log(`packaged app is ${megabytes(directorySize(appOutDir))}`)
}
