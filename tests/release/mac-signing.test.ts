// Signing, tested on a machine that has no certificate — which is every
// machine this has ever run on.
//
// What can be tested without one is the decision: which environment produces an
// unsigned build, which produces a signed one, and which is refused. That
// matters more than it sounds, because the failure mode being designed against
// is silent. Half a set of credentials that fell back to unsigned would produce
// a `.dmg` indistinguishable from a signed one until it was on somebody else's
// Mac, which is the same class of mistake as documentation asserting something
// nobody checked.
//
// What cannot be tested here is whether electron-builder, Apple's notary
// service and Gatekeeper then do what they are supposed to. `docs/releasing.md`
// says exactly which steps that leaves unverified rather than leaving the gap
// implied.
import { describe, expect, it } from 'vitest'
// Both are plain ESM because `npm run release` and electron-builder run them
// as scripts, with no build step between the checkout and the release. On a
// multi-line import the directive has to sit against the specifier rather than
// against the statement, because the specifier is the line TypeScript reports
// the missing declarations on.
import {
  MAC_SIGNING_VARIABLES,
  certificateName,
  describeMacSigning,
  resolveMacSigning
  // @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
} from '../../scripts/mac-signing.mjs'
// @ts-expect-error -- see above.
import { isDistributable, signatureKind, signingReport, soleDmg } from '../../scripts/verify-signing.mjs'

const IDENTITY = 'Developer ID Application: Example Person (AB12CD34EF)'

/** The same set minus the named variables, for the "half a set" cases below. */
function without(env: Record<string, string>, ...omit: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !omit.includes(name)))
}

/** A complete set, in the form Apple recommends. */
const COMPLETE = {
  APPLE_SIGNING_IDENTITY: IDENTITY,
  CSC_LINK: '/tmp/developer-id.p12',
  CSC_KEY_PASSWORD: 'hunter2',
  APPLE_API_KEY: '/tmp/AuthKey_ABC123.p8',
  APPLE_API_KEY_ID: 'ABC123',
  APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555'
}

describe('an environment with nothing in it', () => {
  // The whole point of the default: adding this machinery must not change what
  // a checkout with no credentials produces.
  it('builds exactly what it built before, with no extra flags', () => {
    const plan = resolveMacSigning({})
    expect(plan.mode).toBe('unsigned')
    expect(plan.flags).toEqual([])
  })

  it('ignores a variable that is set to nothing, which is how an unresolved secret arrives', () => {
    expect(resolveMacSigning({ APPLE_SIGNING_IDENTITY: '', CSC_LINK: '   ' }).mode).toBe('unsigned')
  })

  it('says that a downloader will still meet Gatekeeper', () => {
    expect(describeMacSigning(resolveMacSigning({})).join(' ')).toContain('Gatekeeper')
  })
})

describe('a complete set of credentials', () => {
  it('overrides all three settings electron-builder.yml pins', () => {
    const plan = resolveMacSigning(COMPLETE)
    expect(plan.mode).toBe('signed')
    expect(plan.flags).toEqual([
      '-c.mac.identity=Example Person (AB12CD34EF)',
      '-c.mac.hardenedRuntime=true',
      '-c.mac.notarize=true'
    ])
  })

  // Verified against electron-builder 26.15.3 from this repository: handed the
  // string `security find-identity` prints, it refuses with "Please remove
  // prefix \"Developer ID Application:\" from the specified name" — minutes into
  // the build, after the app has been assembled. So the obvious value for the
  // variable is accepted and the prefix taken off here.
  it('takes the identity in the form Apple prints it, and in the form electron-builder wants', () => {
    expect(certificateName(IDENTITY)).toBe('Example Person (AB12CD34EF)')
    expect(certificateName('Example Person (AB12CD34EF)')).toBe('Example Person (AB12CD34EF)')
    expect(certificateName('  Developer ID Application:  Example Person (AB12CD34EF) ')).toBe(
      'Example Person (AB12CD34EF)'
    )
  })

  // The notary service rejects a submission without the hardened runtime, so
  // the two cannot be set separately by accident.
  it('never asks for notarization without the hardened runtime', () => {
    const plan = resolveMacSigning(COMPLETE)
    expect(plan.flags).toContain('-c.mac.hardenedRuntime=true')
  })

  it('takes the older Apple ID form too', () => {
    const plan = resolveMacSigning({
      APPLE_SIGNING_IDENTITY: IDENTITY,
      APPLE_ID: 'person@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
      APPLE_TEAM_ID: 'AB12CD34EF'
    })
    expect(plan.mode).toBe('signed')
    expect(plan.notarize).toBe(true)
  })

  // A certificate already in the login keychain needs no CSC_LINK at all.
  it('does not insist on a .p12 when the certificate is already installed', () => {
    expect(resolveMacSigning(without(COMPLETE, 'CSC_LINK', 'CSC_KEY_PASSWORD')).mode).toBe('signed')
  })
})

describe('half a set is refused, by name', () => {
  const refusalFor = (env: Record<string, string>) => {
    const plan = resolveMacSigning(env)
    expect(plan.mode).toBe('refused')
    return plan.problems.join('\n')
  }

  // The one that matters most: electron-builder.yml pins `identity: '-'`, so a
  // certificate with no identity to override it is imported and then not used.
  it('refuses credentials with no identity to sign as', () => {
    expect(refusalFor(without(COMPLETE, 'APPLE_SIGNING_IDENTITY'))).toContain('APPLE_SIGNING_IDENTITY')
  })

  it('refuses a certificate with no password, and a password with no certificate', () => {
    expect(refusalFor(without(COMPLETE, 'CSC_KEY_PASSWORD'))).toContain('CSC_KEY_PASSWORD')
    expect(refusalFor(without(COMPLETE, 'CSC_LINK'))).toContain('CSC_LINK')
  })

  // Signing without notarizing still produces a build macOS refuses on any
  // machine that downloaded it, so it is a refusal rather than a warning.
  it('refuses an identity with no notarization credentials', () => {
    expect(refusalFor({ APPLE_SIGNING_IDENTITY: IDENTITY })).toContain('No notarization credentials')
  })

  it('names only the half that is missing from the set that was started', () => {
    const problems = refusalFor({
      APPLE_SIGNING_IDENTITY: IDENTITY,
      APPLE_ID: 'person@example.com',
      APPLE_TEAM_ID: 'AB12CD34EF'
    })
    expect(problems).toContain('APPLE_APP_SPECIFIC_PASSWORD')
    expect(problems).not.toContain('APPLE_API_ISSUER')
  })

  it('never falls back to unsigned when something was configured', () => {
    for (const variable of MAC_SIGNING_VARIABLES) {
      expect(resolveMacSigning({ [variable]: 'something' }).mode, variable).not.toBe('unsigned')
    }
  })
})

describe('signing without notarizing, on purpose', () => {
  it('is possible, and says what it costs', () => {
    const plan = resolveMacSigning({ APPLE_SIGNING_IDENTITY: IDENTITY, TEAMREE_SKIP_NOTARIZE: '1' })
    expect(plan.mode).toBe('signed')
    expect(plan.notarize).toBe(false)
    expect(plan.flags).toContain('-c.mac.notarize=false')
    expect(plan.notes.join(' ')).toContain('still refused')
  })
})

describe('reading a signature off a bundle', () => {
  // Real output, captured from `codesign -dv --verbose=4` against this
  // repository's own `npm run package:mac` build. The ad-hoc signature is what
  // electron-builder produces from `identity: '-'`.
  const ADHOC = [
    'Executable=/Users/x/repos/teamree/dist/mac-universal/teamree.app/Contents/MacOS/teamree',
    'Identifier=dev.teamree.app',
    'Format=app bundle with Mach-O universal (x86_64 arm64)',
    'CodeDirectory v=20400 size=424 flags=0x2(adhoc) hashes=3+7 location=embedded',
    'Signature=adhoc',
    'Info.plist entries=27'
  ].join('\n')

  // Constructed, not captured: nothing here has a Developer ID certificate to
  // sign with. What is being tested is this parser, not Apple's output format.
  const DEVELOPER_ID = [
    'Identifier=dev.teamree.app',
    'Signature size=9000',
    `Authority=${IDENTITY}`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    'TeamIdentifier=AB12CD34EF'
  ].join('\n')

  it('tells an ad-hoc signature from a Developer ID one', () => {
    expect(signatureKind(ADHOC)).toBe('adhoc')
    expect(signatureKind(DEVELOPER_ID)).toBe('developer-id')
  })

  it('reads no signature at all as none', () => {
    expect(signatureKind('')).toBe('unsigned')
    expect(signatureKind('teamree.app: code object is not signed at all')).toBe('unsigned')
  })

  it('reports a certificate that is not a Developer ID rather than accepting it', () => {
    const development = DEVELOPER_ID.replace(`Authority=${IDENTITY}`, 'Authority=Apple Development: Person (X)')
    expect(signatureKind(development)).toBe('signed')
    expect(isDistributable(signatureKind(development))).toBe(false)
  })

  // The distinction the whole check exists for: `codesign --verify` exits 0 on
  // this project's ad-hoc build, so a check that stopped there would pass on a
  // build nobody can open. Those exit codes are real, taken from running the
  // four commands against dist/ on this machine.
  it('does not call an ad-hoc build verified just because codesign is happy', () => {
    const report = signingReport({
      kind: 'adhoc',
      checks: {
        'codesign --verify': { status: 0, output: 'valid on disk' },
        'spctl (app)': { status: 3, output: 'rejected' },
        'spctl (dmg)': { status: 3, output: 'rejected\nsource=no usable signature' },
        'stapler (app)': { status: 65, output: 'does not have a ticket stapled to it.' },
        'stapler (dmg)': { status: 65, output: 'does not have a ticket stapled to it.' }
      }
    })
    expect(report.ok).toBe(true)
    expect(report.lines.join('\n')).toContain('ad-hoc signed')
    expect(report.lines.join('\n')).toContain('A copy that was downloaded is refused.')
  })

  it('fails an ad-hoc build when the run was supposed to sign', () => {
    const report = signingReport({ kind: 'adhoc', checks: {}, requireSigned: true })
    expect(report.ok).toBe(false)
  })

  it('requires all four answers of a build that claims a Developer ID', () => {
    const passing = {
      'codesign --verify': { status: 0, output: '' },
      'spctl (app)': { status: 0, output: 'accepted' },
      'spctl (dmg)': { status: 0, output: 'accepted' },
      'stapler (app)': { status: 0, output: 'The validate action worked!' },
      'stapler (dmg)': { status: 0, output: 'The validate action worked!' }
    }
    expect(signingReport({ kind: 'developer-id', checks: passing }).ok).toBe(true)

    for (const name of Object.keys(passing)) {
      const broken = { ...passing, [name]: { status: 3, output: 'rejected' } }
      const report = signingReport({ kind: 'developer-id', checks: broken })
      expect(report.ok, name).toBe(false)
      expect(report.failures, name).toContain(name)
    }
  })

  it('treats a command that could not run at all as a failure', () => {
    const report = signingReport({
      kind: 'developer-id',
      checks: {
        'codesign --verify': { status: null, output: 'spawn codesign ENOENT' },
        'spctl (app)': { status: 0, output: '' },
        'spctl (dmg)': { status: 0, output: '' },
        'stapler (app)': { status: 0, output: '' },
        'stapler (dmg)': { status: 0, output: '' }
      }
    })
    expect(report.ok).toBe(false)
  })
})

describe('which .dmg is the one being published', () => {
  // electron-builder does not clean `dist/` between runs, so a stale image from
  // an earlier version sits there permanently and a release that picked the
  // first one would publish it.
  it('insists on exactly one', () => {
    expect(soleDmg(['teamree-0.1.0.dmg', 'builder-debug.yml'])).toEqual({ dmg: 'teamree-0.1.0.dmg' })
    expect(soleDmg(['builder-debug.yml']).error).toContain('no .dmg')
    expect(soleDmg(['teamree-0.1.0.dmg', 'teamree-0.0.9.dmg']).error).toContain('2 .dmg')
  })

  it('is not fooled by the blockmap that sits beside it', () => {
    expect(soleDmg(['teamree-0.1.0.dmg', 'teamree-0.1.0.dmg.blockmap'])).toEqual({ dmg: 'teamree-0.1.0.dmg' })
  })
})
