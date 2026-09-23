// electron-builder afterPack hook, all about node-pty: keeps it outside the asar, keeps `spawn-helper`
// executable (else every spawn fails "posix_spawnp failed"), prunes ~58 MB of foreign prebuilds,
// and verifies rather than assumes so a broken package fails the build, not a user's terminal.
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
  // Platform, not architecture: `node-gyp-build` picks `prebuilds/darwin-<arch>` at run time, so a
  // universal app needs both, and two per-arch trees that disagree cannot be merged into one asar.
  // `universal` is a third pass over the merged bundle, with no prebuild of its own; it checks both survived.
  const prebuilds = join(pty, 'prebuilds')
  const wantedArches = arch === 'universal' ? ['arm64', 'x64'] : [arch]
  const wanted = wantedArches.map((each) => `${electronPlatformName}-${each}`)
  const keep = (entry) => entry.startsWith(`${electronPlatformName}-`)
  let pruned = 0
  let prunedBytes = 0
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (keep(entry)) continue
      const path = join(prebuilds, entry)
      prunedBytes += directorySize(path)
      rmSync(path, { recursive: true, force: true })
      pruned += 1
    }
    if (pruned) log(`dropped ${pruned} foreign-platform prebuild set(s), ${megabytes(prunedBytes)}`)
  }

  // --- the native module has to exist for every target -----------------------
  // A failed node-gyp run leaves build/Release behind empty, so look for pty.node itself.
  const compiled = join(pty, 'build', 'Release')
  const binaryDirs = wanted.map((name) => {
    const prebuilt = join(prebuilds, name)
    const found = [prebuilt, compiled].find((dir) => existsSync(join(dir, 'pty.node')))
    if (!found) {
      // node-pty publishes no Linux prebuild; a Linux artifact packaged elsewhere ships no PTY at all.
      throw new Error(
        `node-pty has no pty.node for ${name}: it is in neither ${prebuilt} nor ${compiled}. ` +
          `Package the ${electronPlatformName} artifact on ${electronPlatformName}, where npm install builds one.`
      )
    }
    return found
  })
  log(`node-pty binaries found for ${wanted.join(', ')}`)

  // --- spawn-helper has to stay executable ---------------------------------
  // macOS only: node-pty builds spawn-helper under `OS=="mac"` alone; Linux execvp's in process,
  // so demanding the helper there fails a package that is fine.
  if (electronPlatformName === 'darwin') {
    // Every architecture's helper: on a universal build the one that matters is whichever Mac opens it.
    for (const binaryDir of binaryDirs) {
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
      log(`spawn-helper ready at mode ${(verified & 0o777).toString(8)} in ${binaryDir}`)
    }
  }

  // --- the Windows PTY needs more than pty.node ----------------------------
  // node-pty picks ConPTY (conpty.node) or winpty (pty.node + DLL + agent exe) at spawn time;
  // any one missing is invisible until a pane fails to open.
  if (electronPlatformName === 'win32') {
    const required = ['conpty.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe']
    const [binaryDir] = binaryDirs
    const missing = required.filter((name) => !existsSync(join(binaryDir, name)))
    if (missing.length > 0) {
      throw new Error(
        `node-pty is missing ${missing.join(', ')} from ${binaryDir}. ` +
          'Check the files/asarUnpack patterns in electron-builder.yml: without these a packaged ' +
          'Windows app builds cleanly and then fails to open any terminal.'
      )
    }
    log(`Windows PTY backends present: ${required.join(', ')}`)

    // The conpty/ sidecar is loaded by path, not require, so nothing complains at build time if missing.
    const conpty = join(binaryDir, 'conpty')
    const sidecars = ['conpty.dll', 'OpenConsole.exe'].filter((name) => !existsSync(join(conpty, name)))
    if (sidecars.length > 0) {
      throw new Error(`node-pty's bundled ConPTY is incomplete: ${sidecars.join(', ')} missing from ${conpty}.`)
    }
    log('bundled ConPTY sidecar is complete')
  }

  // --- the shipped launchers have to stay executable ------------------------
  // Neither is exec'd by Electron: the CLI launcher is what the /usr/local/bin symlink points at, the
  // relay launcher is the first word of a shell command (`shippedRelayCommand`). A 0644 file gets
  // "permission denied" from the shell, so the Teamwork panel's button would be dead for every .dmg user.
  if (electronPlatformName !== 'win32') {
    // `.cmd` on Windows is not a program; on macOS and Linux both are `#!/bin/sh` scripts.
    for (const [what, ...segments] of [
      ['CLI', 'cli', 'teamree'],
      ['relay', 'relay', 'teamree-relay']
    ]) {
      const launcher = join(resources, ...segments)
      if (!existsSync(launcher)) throw new Error(`the ${what} launcher is missing from ${launcher}.`)
      chmodSync(launcher, 0o755)
      const mode = statSync(launcher).mode
      if (!(mode & 0o111)) {
        throw new Error(`could not make ${launcher} executable (mode ${(mode & 0o777).toString(8)}).`)
      }
      log(`${what} launcher installed at ${segments.join('/')}, mode ${(mode & 0o777).toString(8)}`)
    }
  }

  log(`packaged app is ${megabytes(directorySize(appOutDir))}`)
}
