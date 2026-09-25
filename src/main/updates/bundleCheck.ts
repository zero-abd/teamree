// What the Mac says about an app bundle (identifier, version, signature), and the rules a
// staged bundle and the running copy's location have to pass before one replaces the other.

import { execFile } from 'node:child_process'
import { basename, dirname } from 'node:path'

export type SignatureKind = 'adhoc' | 'developer-id' | 'signed' | 'unsigned'

export type Signature = {
  kind: SignatureKind
  teamId: string | null
  /** `codesign --verify --deep --strict` passed. */
  valid: boolean
}

export type BundleFacts = { identifier: string; version: string; signature: Signature }

/** Reads a bundle's facts; null when it has no readable Info.plist. `plutil` and `codesign` in the app. */
export type BundleProbe = (app: string) => Promise<BundleFacts | null>

/** `codesign -dv` output read the way scripts/verify-signing.mjs reads it. */
export function readSignature(display: string, valid: boolean): Signature {
  const team = /^TeamIdentifier=(.+)$/m.exec(display)?.[1]?.trim()
  const teamId = team === undefined || team === 'not set' ? null : team
  let kind: SignatureKind = 'unsigned'
  if (/code object is not signed at all/.test(display)) kind = 'unsigned'
  else if (/^Signature=adhoc$/m.test(display)) kind = 'adhoc'
  else if (/^Authority=Developer ID Application:/m.test(display)) kind = 'developer-id'
  else if (/^Authority=/m.test(display)) kind = 'signed'
  return { kind, teamId, valid: valid && kind !== 'unsigned' }
}

/** Why `staged` may not replace `running` at `version`, or null when it may. */
export function stagingRefusal(options: {
  staged: BundleFacts | null
  running: BundleFacts
  version: string
}): string | null {
  const { staged, running, version } = options
  if (staged === null) return 'the archive held no app'
  if (staged.identifier !== running.identifier) {
    return `the staged app's identifier is ${staged.identifier}, not ${running.identifier}`
  }
  if (staged.version !== version) return `the staged app's version is ${staged.version}, not ${version}`
  if (!staged.signature.valid) return "the staged app's signature does not verify"
  // A Developer ID build only ever hands over to the same team; an ad-hoc one to any valid signature.
  if (running.signature.teamId !== null && staged.signature.teamId !== running.signature.teamId) {
    return `the staged app's Team ID is ${staged.signature.teamId ?? 'not set'}, not ${running.signature.teamId}`
  }
  if (running.signature.kind === 'developer-id' && staged.signature.kind !== 'developer-id') {
    return 'the staged app is not signed with a Developer ID'
  }
  return null
}

/** The `.app` an executable at `…/X.app/Contents/MacOS/x` belongs to, or null. */
export function bundleOf(executable: string): string | null {
  const macos = dirname(executable)
  const contents = dirname(macos)
  const app = dirname(contents)
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !app.endsWith('.app')) return null
  return app
}

/** Why the copy at `bundle` cannot be replaced where it is, or null when it can. */
export function locationRefusal(bundle: string, writable: (path: string) => boolean): string | null {
  // Gatekeeper runs a quarantined app from a random read-only path until it is moved.
  if (bundle.includes('/AppTranslocation/')) return 'it is running translocated'
  if (bundle.startsWith('/Volumes/')) return 'it is running from a disk image'
  if (!writable(dirname(bundle)) || !writable(bundle)) return `${dirname(bundle)} is not writable`
  return null
}

function run(file: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr })
    })
  })
}

/** The probe the app uses: `plutil` for the Info.plist, `codesign` for the signature. */
export const macBundleProbe: BundleProbe = async (app) => {
  const plist = `${app}/Contents/Info.plist`
  const [identifier, version] = await Promise.all([
    run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]),
    run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])
  ])
  if (!identifier.ok || !version.ok) return null
  const [display, verify] = await Promise.all([
    run('/usr/bin/codesign', ['-dv', '--verbose=2', app]),
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  ])
  return {
    identifier: identifier.stdout.trim(),
    version: version.stdout.trim(),
    signature: readSignature(display.stderr, verify.ok)
  }
}
