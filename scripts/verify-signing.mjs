// What a downloader's Mac will make of this build, asked here instead of there.
//
// `npm run package:verify` launches the packaged app and proves it works. It
// proves nothing about whether anybody else can open it, because the machine
// that built a file is the one machine where Gatekeeper never sees it: a local
// build carries no `com.apple.quarantine` attribute, so it opens here whatever
// its signature says. That is exactly the gap this project shipped into — a
// build that started every time it was tried and refused every time it was
// downloaded.
//
// So this runs the three questions a downloaded copy is put to, in the order
// they matter, and says which answer came back:
//
//   codesign --verify --deep --strict   is the signature structurally intact?
//   spctl --assess                      would Gatekeeper let this run?
//   xcrun stapler validate              is a notarization ticket attached?
//
// The first of those is the one worth being careful about: on this repository's
// own ad-hoc build it exits 0. An intact signature is not a Developer ID, so a
// check that stopped there would pass on a build nobody can open. What separates
// them is `codesign -dv`, which prints `Signature=adhoc` for one and an
// `Authority=Developer ID Application: ...` line for the other.
//
// Unsigned is not a failure here. It is the configuration this project ships by
// default, and the run says so in the words a reader needs rather than a number.
// `--require-signed` turns it into one, for a release that was meant to be
// signed.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findPackagedApp } from './packaged-app.mjs'

/**
 * Which kind of signature `codesign -dv` is describing.
 *
 * `adhoc` and `developer-id` are the two this project can produce; `signed`
 * covers a certificate that is neither (a Mac App Store or development
 * certificate, which would not be distributable either) so that it is reported
 * rather than mistaken for a Developer ID.
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
 * The verdict, from the four command results and the kind of signature found.
 *
 * A pure function over exit statuses, so the interesting half is testable on a
 * machine with no certificate on it — which is every machine this has run on.
 *
 * `checks` is keyed by the name each check is reported under; each value is
 * `{ status, output }`. A `status` of null means the command could not be run
 * at all, which is a failure whatever was being asked.
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
    // Every one of the four has to pass. A downloaded copy is put to all of
    // them and stops at the first that says no.
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
    // Reported, not required: these are the answers that make the sentence
    // above concrete rather than a claim.
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
 * What is actually on a bundle, asked of `codesign` directly.
 *
 * Used by `package-mac.mjs` as well as by the run below, because
 * electron-builder does not fail when it cannot find the identity it was given:
 * it prints "skipped macOS application code signing ... no valid identity with
 * this name in the keychain", ad-hoc signs, and exits 0. That is verified
 * behaviour, seen here from electron-builder 26.15.3, and it is the one way a
 * run that was asked to sign can hand back an unsigned build without saying so.
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
    // `-t open --context context:primary-signature` is the assessment a disk
    // image is put to when it is opened, which is the first thing that happens
    // to the file that actually leaves here.
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
