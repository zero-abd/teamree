// The comparison, which is the part of this feature that can be quietly wrong.
//
// Every case below is a version pair somebody could actually be looking at: a
// two-digit minor against a one-digit one, a candidate against the release it
// precedes, a tag with its `v` against one without. A string comparison passes
// about half of them, which is why there are this many.

import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerRelease, isPrereleaseVersion, parseVersion } from './semver'

/** Parses, or fails the test rather than returning null into an expectation. */
function version(raw: string) {
  const parsed = parseVersion(raw)
  if (parsed === null) throw new Error(`${raw} did not parse`)
  return parsed
}

function newer(candidate: string, current: string): boolean {
  return isNewerRelease(version(candidate), version(current))
}

describe('parsing a version', () => {
  it('takes the `v` a release tag carries, and one without it', () => {
    expect(parseVersion('v0.1.2')).toMatchObject({ major: 0, minor: 1, patch: 2, raw: '0.1.2' })
    expect(parseVersion('0.1.2')).toMatchObject({ major: 0, minor: 1, patch: 2, raw: '0.1.2' })
  })

  it('splits a pre-release into identifiers, numeric ones as numbers', () => {
    expect(version('v1.2.3-rc.10').prerelease).toEqual(['rc', 10])
    expect(isPrereleaseVersion(version('1.2.3-rc.1'))).toBe(true)
    expect(isPrereleaseVersion(version('1.2.3'))).toBe(false)
  })

  it('drops build metadata, which takes no part in precedence', () => {
    expect(compareVersions(version('1.2.3+build.5'), version('1.2.3'))).toBe(0)
    expect(compareVersions(version('1.2.3+a'), version('1.2.3+b'))).toBe(0)
  })

  it('refuses anything that is not a version, rather than guessing at one', () => {
    for (const raw of ['', 'latest', '1.2', 'v1.2', '1.2.3.4', 'main', 'v1.2.3 ; rm -rf /', '01.2.3-']) {
      expect(parseVersion(raw), raw).toBeNull()
    }
  })
})

describe('which of two versions is the later', () => {
  // The whole reason this module exists rather than a `>`: as strings, '0.9.0'
  // sorts after '0.10.0', and somebody on 0.9.0 is then told they are current.
  it('compares the numbers as numbers', () => {
    expect(newer('0.10.0', '0.9.0')).toBe(true)
    expect(newer('0.9.0', '0.10.0')).toBe(false)
    expect(newer('1.0.0', '0.99.99')).toBe(true)
    expect(newer('0.1.10', '0.1.9')).toBe(true)
  })

  it('says nothing is newer than itself', () => {
    expect(newer('0.1.2', '0.1.2')).toBe(false)
    expect(compareVersions(version('0.1.2'), version('0.1.2'))).toBe(0)
  })

  it('sorts a pre-release before the release it is a candidate for', () => {
    expect(compareVersions(version('1.0.0-rc.1'), version('1.0.0'))).toBeLessThan(0)
    expect(compareVersions(version('1.0.0'), version('1.0.0-rc.1'))).toBeGreaterThan(0)
  })

  it('orders pre-release identifiers the way semver does', () => {
    const ascending = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-rc.1']
    for (let index = 1; index < ascending.length; index += 1) {
      const before = ascending[index - 1] as string
      const after = ascending[index] as string
      expect(compareVersions(version(after), version(before)), `${after} after ${before}`).toBeGreaterThan(0)
    }
    // Numeric identifiers have lower precedence than alphanumeric ones, which
    // is the rule a text comparison gets backwards.
    expect(compareVersions(version('1.0.0-1'), version('1.0.0-alpha'))).toBeLessThan(0)
  })
})

describe('who is offered a pre-release', () => {
  // Somebody on a stable build did not ask to test anything.
  it('never offers a candidate to a stable build, even a much later one', () => {
    expect(newer('0.3.0-rc.1', '0.1.2')).toBe(false)
    expect(newer('9.9.9-beta.1', '0.1.2')).toBe(false)
  })

  it('offers one to somebody already running a candidate, because they opted in', () => {
    expect(newer('0.3.0-rc.2', '0.3.0-rc.1')).toBe(true)
    expect(newer('0.3.0-rc.1', '0.3.0-rc.2')).toBe(false)
  })

  it('offers the finished release to somebody on its candidate', () => {
    expect(newer('0.3.0', '0.3.0-rc.1')).toBe(true)
  })
})
