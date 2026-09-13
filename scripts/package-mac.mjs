// `npm run package:mac`, with the signing decision made before the build.
//
// This used to be `electron-builder --mac --publish never` in package.json, and
// it still is when no credentials are set: `resolveMacSigning` returns no flags
// and the command below is the command that was there. What it adds is the
// other two cases — a complete set of credentials, which turns the same command
// into a signed and notarized build, and half a set, which stops now instead of
// forty minutes from now.
//
// Anything after `--` on the npm command line is passed through, so
// `npm run package:mac -- -c.mac.notarize=false` still works and still wins:
// electron-builder takes the last value for a repeated flag.
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

// Run through `process.execPath` rather than the `.bin` shim: one fewer thing
// that has to be present and executable, and it keeps the Node that npm chose.
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

// A build that was asked to sign and did not is the one failure that reaches
// people. electron-builder does not raise it: given an identity that is not in
// the keychain it logs "skipped macOS application code signing", ad-hoc signs
// and exits 0 — verified here against electron-builder 26.15.3 by pointing it
// at an identity that does not exist. So the signature is read back off the
// bundle rather than inferred from the exit code.
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
