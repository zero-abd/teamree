// What makes a staged bundle acceptable, and where a running copy can replace itself.

import { describe, expect, it } from 'vitest'
import { bundleOf, locationRefusal, readSignature, stagingRefusal, type BundleFacts } from './bundleCheck'

const ADHOC = 'Identifier=dev.teamree.app\nSignature=adhoc\nTeamIdentifier=not set\n'
const DEVELOPER_ID =
  'Identifier=dev.teamree.app\nAuthority=Developer ID Application: Someone (AB12CD34EF)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=AB12CD34EF\n'

describe('reading a signature', () => {
  it('tells ad-hoc, Developer ID and unsigned apart', () => {
    expect(readSignature(ADHOC, true)).toEqual({ kind: 'adhoc', teamId: null, valid: true })
    expect(readSignature(DEVELOPER_ID, true)).toEqual({ kind: 'developer-id', teamId: 'AB12CD34EF', valid: true })
    expect(readSignature('x: code object is not signed at all', false)).toEqual({
      kind: 'unsigned',
      teamId: null,
      valid: false
    })
  })
})

function facts(overrides: Partial<BundleFacts> = {}): BundleFacts {
  return {
    identifier: 'dev.teamree.app',
    version: '0.3.0',
    signature: { kind: 'adhoc', teamId: null, valid: true },
    ...overrides
  }
}

describe('accepting a staged bundle', () => {
  const running = facts({ version: '0.2.0' })

  it('takes a valid bundle of this app at the promised version', () => {
    expect(stagingRefusal({ staged: facts(), running, version: '0.3.0' })).toBeNull()
  })

  it('refuses another app, another version, or a missing Info.plist', () => {
    expect(stagingRefusal({ staged: facts({ identifier: 'com.github.Electron' }), running, version: '0.3.0' })).toMatch(
      /identifier/
    )
    expect(stagingRefusal({ staged: facts({ version: '0.2.9' }), running, version: '0.3.0' })).toMatch(/version/)
    expect(stagingRefusal({ staged: null, running, version: '0.3.0' })).toMatch(/no app/)
  })

  it('refuses a signature that does not verify, even on an ad-hoc build', () => {
    const broken = facts({ signature: { kind: 'adhoc', teamId: null, valid: false } })
    expect(stagingRefusal({ staged: broken, running, version: '0.3.0' })).toMatch(/signature/)
  })

  it('holds a Developer ID build to its own Team ID', () => {
    const signed = facts({ version: '0.2.0', signature: { kind: 'developer-id', teamId: 'AB12CD34EF', valid: true } })
    const same = facts({ signature: { kind: 'developer-id', teamId: 'AB12CD34EF', valid: true } })
    const other = facts({ signature: { kind: 'developer-id', teamId: 'ZZ99YY88XX', valid: true } })
    expect(stagingRefusal({ staged: same, running: signed, version: '0.3.0' })).toBeNull()
    expect(stagingRefusal({ staged: other, running: signed, version: '0.3.0' })).toMatch(/Team ID/)
    expect(stagingRefusal({ staged: facts(), running: signed, version: '0.3.0' })).toMatch(/Team ID/)
  })

  it('lets an ad-hoc build move to a Developer ID one', () => {
    const signed = facts({ signature: { kind: 'developer-id', teamId: 'AB12CD34EF', valid: true } })
    expect(stagingRefusal({ staged: signed, running, version: '0.3.0' })).toBeNull()
  })
})

describe('where a copy can replace itself', () => {
  const writable = (): boolean => true

  it('finds the bundle around the executable', () => {
    expect(bundleOf('/Applications/teamree.app/Contents/MacOS/teamree')).toBe('/Applications/teamree.app')
    expect(bundleOf('/usr/local/bin/node')).toBeNull()
  })

  it('accepts a writable folder', () => {
    expect(locationRefusal('/Applications/teamree.app', writable)).toBeNull()
    expect(locationRefusal('/Users/me/Applications/teamree.app', writable)).toBeNull()
  })

  it('refuses a translocated copy, a disk image and a folder it cannot write', () => {
    expect(locationRefusal('/private/var/folders/x/AppTranslocation/1234-ABCD/d/teamree.app', writable)).toMatch(
      /translocated/
    )
    expect(locationRefusal('/Volumes/teamree 0.2.0/teamree.app', writable)).toMatch(/disk image/)
    expect(locationRefusal('/Applications/teamree.app', (path) => path !== '/Applications')).toMatch(/writable/)
    expect(locationRefusal('/Applications/teamree.app', (path) => path !== '/Applications/teamree.app')).toMatch(
      /writable/
    )
  })
})
