// What `npm run package:mac` does about a signing identity, when there is one.
//
// `electron-builder.yml` pins `identity: '-'`, `hardenedRuntime: false` and
// `notarize: false`, which is what produces the ad-hoc build this project has
// always made. Those three settings are the whole of the difference between a
// build that opens here and a build somebody can download, and until now the
// way to change them was a paragraph of comment telling a maintainer which
// flags to type. A flag you have to type is a flag you can mistype, and the
// failure is silent in the worst direction: an unsigned `.dmg` published as a
// signed one looks identical until it is on somebody else's Mac.
//
// So the decision moved here, and it is made from the environment. Set nothing
// and the build is exactly the build it was; set a complete set of credentials
// and the same command produces a signed, notarized one. Set half a set and it
// refuses, by name, rather than quietly falling back to unsigned — falling back
// is the one behaviour that could send an unsigned build out under the belief
// that it was signed.
//
// Nothing here has been run against a real certificate. See `docs/releasing.md`
// for exactly which steps that leaves unverified.

/** The identity to sign with: the full string, as `security find-identity` prints it. */
const IDENTITY = 'APPLE_SIGNING_IDENTITY'

/**
 * The certificate itself, when it is not already in the login keychain.
 *
 * electron-builder reads both of these by itself; they are named here only so
 * that half a pair is caught before a forty-minute build rather than inside it.
 */
const CERTIFICATE = ['CSC_LINK', 'CSC_KEY_PASSWORD']

/** App Store Connect API key: the form Apple recommends, and the only one with no password in it. */
const NOTARY_API_KEY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

/** The older form: an Apple ID and an app-specific password. */
const NOTARY_APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

/** Sign, but do not notarize. An escape hatch with a warning attached, not a default. */
const SKIP_NOTARIZE = 'TEAMREE_SKIP_NOTARIZE'

/**
 * Every variable whose presence means somebody intended to sign.
 *
 * The list is what makes "set nothing, get the old behaviour" and "set half a
 * set, get a refusal" distinguishable. Without it, a missing `CSC_KEY_PASSWORD`
 * and an unconfigured machine look the same.
 */
export const MAC_SIGNING_VARIABLES = [IDENTITY, ...CERTIFICATE, ...NOTARY_API_KEY, ...NOTARY_APPLE_ID]

/**
 * The identity as electron-builder wants it, from the identity as Apple prints it.
 *
 * `security find-identity -v -p codesigning` — the command anybody would use to
 * find out what to put here — prints the full string, prefix and all:
 *
 *   "Developer ID Application: Your Name (AB12CD34EF)"
 *
 * Hand that to electron-builder and it refuses, with
 * "Please remove prefix \"Developer ID Application:\" from the specified name".
 * That is a real refusal seen from this repository, and it arrives at the end of
 * the packing step, several minutes in, after the app has been assembled.
 *
 * So both spellings are accepted here and the prefix is taken off. The
 * alternative is a documented variable whose obvious value is wrong.
 */
export function certificateName(identity) {
  return identity.trim().replace(/^Developer ID Application:\s*/i, '')
}

/** Set, and not set to whitespace. An empty string in CI is how a secret that did not resolve arrives. */
function present(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== ''
}

function missingFrom(env, group) {
  return group.filter((name) => !present(env, name))
}

/**
 * How `npm run package:mac` should be run, given this environment.
 *
 * Returns one of three shapes, all of them with a `mode`:
 *
 *   `unsigned`  no signing variable is set. `flags` is empty and the build is
 *               byte-for-byte the build this repository has always produced.
 *   `signed`    a complete set is present. `flags` carries the three
 *               `-c.mac.*` overrides, and `notarize` says whether the ticket
 *               will be requested.
 *   `refused`   something is set and something else is missing. `problems`
 *               names each one and what to do about it; no build is started.
 */
export function resolveMacSigning(env = process.env) {
  const configured = MAC_SIGNING_VARIABLES.filter((name) => present(env, name))

  if (configured.length === 0) {
    return {
      mode: 'unsigned',
      flags: [],
      notarize: false,
      notes: [
        'No signing credentials in the environment, so this is an unsigned build.',
        'It is ad-hoc signed, which is what Apple Silicon needs to launch it at all, and',
        'it will run on this machine. Anybody who downloads it meets Gatekeeper.',
        `To sign, see docs/releasing.md — it names all ${MAC_SIGNING_VARIABLES.length} variables.`
      ]
    }
  }

  const problems = []

  if (!present(env, IDENTITY)) {
    problems.push(
      `${configured.join(', ')} ${configured.length === 1 ? 'is' : 'are'} set but ${IDENTITY} is not.\n` +
        `  electron-builder.yml pins the identity to '-' (ad-hoc), so without ${IDENTITY}\n` +
        '  to override it the certificate would be imported and then not used. Set it to the\n' +
        '  name `security find-identity -v -p codesigning` prints:\n' +
        '  APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)".'
    )
  }

  const missingCertificate = missingFrom(env, CERTIFICATE)
  if (missingCertificate.length === 1) {
    problems.push(
      `${missingCertificate[0]} is not set, and the other half of the pair is.\n` +
        '  CSC_LINK (a base64 .p12, or a path to one) and CSC_KEY_PASSWORD go together.\n' +
        '  Unset both to sign with a certificate already in your login keychain.'
    )
  }

  const notarization = resolveNotarization(env)
  if (notarization.problem) problems.push(notarization.problem)

  if (problems.length > 0) return { mode: 'refused', problems }

  return {
    mode: 'signed',
    notarize: notarization.notarize,
    identity: certificateName(env[IDENTITY]),
    // `hardenedRuntime` and `notarize` move together because Apple's notary
    // service rejects a submission without the hardened runtime, so signing
    // with one and not the other buys a rejection at the end of the build.
    // build/entitlements.mac.plist is already written for it.
    flags: [
      `-c.mac.identity=${certificateName(env[IDENTITY])}`,
      '-c.mac.hardenedRuntime=true',
      `-c.mac.notarize=${notarization.notarize}`
    ],
    notes: notarization.notes
  }
}

function resolveNotarization(env) {
  if (env[SKIP_NOTARIZE] === '1') {
    return {
      notarize: false,
      notes: [
        `${SKIP_NOTARIZE}=1: signing with a Developer ID but NOT notarizing.`,
        'A signed build that carries no notarization ticket is still refused on a Mac that',
        'downloaded it — Gatekeeper wants the ticket, not only the signature. Use this to',
        'test the signing half on its own, not to publish.'
      ]
    }
  }

  const missingApiKey = missingFrom(env, NOTARY_API_KEY)
  const missingAppleId = missingFrom(env, NOTARY_APPLE_ID)

  if (missingApiKey.length === 0 || missingAppleId.length === 0) {
    const using = missingApiKey.length === 0 ? 'an App Store Connect API key' : 'an Apple ID and app-specific password'
    return { notarize: true, notes: [`Notarizing with ${using}.`] }
  }

  // Nothing at all from either set: say what the two choices are.
  if (missingApiKey.length === NOTARY_API_KEY.length && missingAppleId.length === NOTARY_APPLE_ID.length) {
    return {
      notarize: false,
      problem:
        'No notarization credentials. Signing without notarizing produces a build macOS still\n' +
        '  refuses on any machine that downloaded it, so this is a refusal rather than a warning.\n' +
        `  Set either ${NOTARY_API_KEY.join(', ')}\n` +
        `  or ${NOTARY_APPLE_ID.join(', ')}.\n` +
        `  To sign without notarizing anyway — for testing the signing half — set ${SKIP_NOTARIZE}=1.`
    }
  }

  // Half of one set. Name the half that is missing, and only that one.
  const started = missingApiKey.length < NOTARY_API_KEY.length ? missingApiKey : missingAppleId
  return {
    notarize: false,
    problem:
      `Incomplete notarization credentials: ${started.join(', ')} ${started.length === 1 ? 'is' : 'are'} not set.\n` +
      '  The set that was started has to be complete; the two sets are alternatives, not a mixture.'
  }
}

/** The plan as lines to print before a build, so what happened is on the log. */
export function describeMacSigning(plan) {
  if (plan.mode === 'refused') {
    return ['package-mac: refusing to build.', ...plan.problems.map((problem) => `- ${problem}`)]
  }
  const headline =
    plan.mode === 'signed'
      ? `package-mac: signing as ${plan.identity}, ${plan.notarize ? 'and notarizing' : 'without notarizing'}.`
      : 'package-mac: building unsigned.'
  return [headline, ...plan.notes.map((note) => `  ${note}`)]
}
