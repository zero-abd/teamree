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
  // The directory existing is not the same as the binary being in it: a failed
  // node-gyp run leaves build/Release behind empty, so look for pty.node itself.
  const prebuilt = join(prebuilds, wanted)
  const compiled = join(pty, 'build', 'Release')
  const binaryDir = [prebuilt, compiled].find((dir) => existsSync(join(dir, 'pty.node')))
  if (!binaryDir) {
    // node-pty publishes no Linux prebuild: it is compiled by `npm install`, so
    // a Linux artifact packaged on macOS or Windows would ship no PTY at all.
    throw new Error(
      `node-pty has no pty.node for ${wanted}: it is in neither ${prebuilt} nor ${compiled}. ` +
        `Package the ${electronPlatformName} artifact on ${electronPlatformName}, where npm install builds one.`
    )
  }
  log(`node-pty binary for ${wanted} found in ${binaryDir}`)

  // --- spawn-helper has to stay executable ---------------------------------
  // macOS only, and deliberately not "every platform that is not Windows":
  // node-pty builds spawn-helper under `OS=="mac"` alone and calls it from a
  // `#if defined(__APPLE__)` branch of pty.cc. Linux forks and execvp's in
  // process, so demanding the helper there fails a package that is in fact fine.
  if (electronPlatformName === 'darwin') {
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

  // --- the Windows PTY needs more than pty.node ----------------------------
  // Windows is the platform this project cannot run, so its failures have to be
  // made to happen here, on the Windows runner, rather than on a user's machine
  // the first time they open a terminal. node-pty picks its backend at spawn
  // time: ConPTY out of conpty.node, falling back to winpty, which is pty.node
  // plus a DLL and a separate agent executable it launches. Any one of these
  // missing is invisible until a pane fails to open, so all of them are checked.
  if (electronPlatformName === 'win32') {
    const required = ['conpty.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe']
    const missing = required.filter((name) => !existsSync(join(binaryDir, name)))
    if (missing.length > 0) {
      throw new Error(
        `node-pty is missing ${missing.join(', ')} from ${binaryDir}. ` +
          'Check the files/asarUnpack patterns in electron-builder.yml: without these a packaged ' +
          'Windows app builds cleanly and then fails to open any terminal.'
      )
    }
    log(`Windows PTY backends present: ${required.join(', ')}`)

    // The conpty/ sidecar carries the Windows Terminal ConPTY implementation
    // node-pty prefers over the one in the OS. It is loaded by path, not by
    // require, so nothing would complain at build time if it went missing.
    const conpty = join(binaryDir, 'conpty')
    const sidecars = ['conpty.dll', 'OpenConsole.exe'].filter((name) => !existsSync(join(conpty, name)))
    if (sidecars.length > 0) {
      throw new Error(`node-pty's bundled ConPTY is incomplete: ${sidecars.join(', ')} missing from ${conpty}.`)
    }
    log('bundled ConPTY sidecar is complete')
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
