// `npm run package:mac` with the signing decision (`resolveMacSigning`) made before the build. Arguments
// after `--` pass through and win, since electron-builder takes the last value of a repeated flag.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeMacSigning, resolveMacSigning } from './mac-signing.mjs'
import { findPackagedApp } from './packaged-app.mjs'
import { isDistributable, readSignatureKind } from './verify-signing.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON_BUILDER = join(REPO_ROOT, 'node_modules', 'electron-builder', 'cli.js')

const plan = resolveMacSigning(process.env)

for (const line of describeMacSigning(plan)) console[plan.mode === 'refused' ? 'error' : 'log'](line)

if (plan.mode === 'refused') process.exit(1)

// `process.execPath`, not the `.bin` shim: keeps the Node npm chose.
const args = [ELECTRON_BUILDER, '--mac', '--publish', 'never', ...plan.flags, ...process.argv.slice(2)]

const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: REPO_ROOT })

if (result.error) {
  console.error(`package-mac: could not run electron-builder: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  console.error(`package-mac: electron-builder was killed by ${result.signal}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

// electron-builder given a missing identity ad-hoc signs and exits 0 (checked on 26.15.3), so the
// signature is read back off the bundle.
if (plan.mode === 'signed') {
  const app = findPackagedApp()
  const kind = app ? readSignatureKind(app) : 'unsigned'
  if (!isDistributable(kind)) {
    console.error(`package-mac: asked to sign as ${plan.identity}, but the packaged app is ${kind}.`)
    console.error('package-mac: electron-builder skips signing rather than failing when it cannot find')
    console.error('package-mac: the identity. Check `security find-identity -v -p codesigning`.')
    process.exit(1)
  }
  console.log(`package-mac: signed — ${app} carries a Developer ID signature.`)
}

process.exit(0)
