// What a downloader's Mac will make of this build: a local build carries no `com.apple.quarantine`,
// so Gatekeeper never sees it here. Runs codesign --verify, spctl --assess and stapler validate;
// codesign exits 0 on an ad-hoc build too, so `codesign -dv` decides the kind. Unsigned only fails with `--require-signed`.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findPackagedApp } from './packaged-app.mjs'

/**
 * Which kind of signature `codesign -dv` is describing. `signed` is a certificate that is neither
 * ad-hoc nor Developer ID, reported rather than mistaken for one.
 */
export function signatureKind(display) {
  if (typeof display !== 'string' || display.trim() === '') return 'unsigned'
  if (/code object is not signed at all/.test(display)) return 'unsigned'
  if (/^Signature=adhoc$/m.test(display)) return 'adhoc'
  if (/^Authority=Developer ID Application:/m.test(display)) return 'developer-id'
  if (/^Signature size=/m.test(display) || /^Authority=/m.test(display)) return 'signed'
  return 'unsigned'
}

/** Whether a kind of signature is one somebody else's Mac could accept. */
export function isDistributable(kind) {
  return kind === 'developer-id'
}

/**
 * The verdict, pure over exit statuses so it is testable without a certificate.
 * `checks` is keyed by check name; a `status` of null means the command could not run.
 */
export function signingReport({ kind, checks, requireSigned = false }) {
  const lines = []
  const failures = []

  const verdict = (name, expected) => {
    const check = checks[name]
    if (!check) return null
    const passed = check.status === expected
    lines.push(`${passed ? 'ok  ' : 'FAIL'} ${name} (exit ${check.status ?? 'could not run'})`)
    return passed
  }

  if (isDistributable(kind)) {
    lines.push('This build is signed with a Developer ID.')
    // A downloaded copy is put to all of them and stops at the first that says no.
    for (const name of ['codesign --verify', 'spctl (app)', 'spctl (dmg)', 'stapler (app)', 'stapler (dmg)']) {
      if (checks[name] && verdict(name, 0) === false) failures.push(name)
    }
  } else {
    lines.push(
      kind === 'adhoc'
        ? 'This build is ad-hoc signed: a valid signature with no identity behind it.'
        : kind === 'signed'
          ? 'This build carries a certificate that is not a Developer ID, so it is not distributable.'
          : 'This build carries no signature at all.'
    )
    lines.push('It opens on the machine that built it, because a local build carries no quarantine')
    lines.push('attribute for Gatekeeper to act on. A copy that was downloaded is refused.')
    lines.push('')
    // Reported, not required.
    verdict('codesign --verify', 0)
    verdict('spctl (app)', 0)
    verdict('spctl (dmg)', 0)
    verdict('stapler (app)', 0)
    verdict('stapler (dmg)', 0)
    if (requireSigned) failures.push('a Developer ID signature was required and this build has none')
  }

  return { ok: failures.length === 0, kind, lines, failures }
}

/**
 * What is actually on a bundle, asked of `codesign`. electron-builder 26.15.3 prints "skipped macOS
 * application code signing", ad-hoc signs and exits 0 when the identity is missing; this catches that.
 */
export function readSignatureKind(app) {
  const shown = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' })
  return signatureKind([shown.stdout ?? '', shown.stderr ?? ''].join(''))
}

/** The sole `.dmg` in `dist/`, or a reason there is not exactly one. */
export function soleDmg(names) {
  const dmgs = names.filter((name) => name.endsWith('.dmg'))
  if (dmgs.length === 1) return { dmg: dmgs[0] }
  return {
    error:
      dmgs.length === 0
        ? 'no .dmg in dist/ — run `npm run package:mac` first.'
        : `${dmgs.length} .dmg files in dist/ (${dmgs.join(', ')}); dist/ is not cleaned between builds, ` +
          'so delete the ones that are not this build.'
  }
}

// ---------------------------------------------------------------- the run --

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    status: result.error ? null : result.status,
    output: [result.stdout ?? '', result.stderr ?? ''].join('').trim() || (result.error?.message ?? '')
  }
}

function main(argv) {
  const requireSigned = argv.includes('--require-signed')

  const app = findPackagedApp()
  if (!app || !existsSync(app)) {
    console.error('verify-signing: no packaged app in dist/ — run `npm run package:mac` first.')
    return 1
  }

  const found = soleDmg(existsSync('dist') ? readdirSync('dist') : [])
  if (found.error) {
    console.error(`verify-signing: ${found.error}`)
    return 1
  }
  const dmg = join('dist', found.dmg)

  console.log(`verify-signing: ${app}`)
  console.log(`verify-signing: ${dmg}`)
  console.log('')

  const kind = readSignatureKind(app)

  const checks = {
    'codesign --verify': run('codesign', ['--verify', '--deep', '--strict', app]),
    // `-t exec` is the assessment an app bundle is put to on launch.
    'spctl (app)': run('spctl', ['--assess', '-t', 'exec', '-vv', app]),
    // `-t open --context context:primary-signature` is the assessment a disk image is put to on open.
    'spctl (dmg)': run('spctl', ['--assess', '-t', 'open', '--context', 'context:primary-signature', '-v', dmg]),
    'stapler (app)': run('xcrun', ['stapler', 'validate', app]),
    'stapler (dmg)': run('xcrun', ['stapler', 'validate', dmg])
  }

  const report = signingReport({ kind, checks, requireSigned })
  for (const line of report.lines) console.log(line)
  console.log('')
  for (const [name, check] of Object.entries(checks)) {
    console.log(`--- ${name} ---`)
    console.log(check.output || '(no output)')
  }

  if (!report.ok) {
    console.error('')
    for (const failure of report.failures) console.error(`verify-signing: FAIL ${failure}`)
    return 1
  }
  console.log('')
  console.log(`verify-signing: ok — ${kind}`)
  return 0
}

if (process.argv[1] && process.argv[1].endsWith('verify-signing.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
