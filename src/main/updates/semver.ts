// Comparing two version strings, which is the whole of deciding whether the
// download page has something this build does not.
//
// It is written out rather than taken from a package for one reason: comparing
// versions by string is the bug this feature is most likely to ship with, and
// it is the kind that looks right for months. `'0.10.0' > '0.9.0'` is false,
// and somebody on 0.9.0 is then told they are current for as long as the minor
// number has two digits. So this is the part with the most tests behind it, and
// there is no string comparison anywhere below.
//
// The rules are semver's own, and the two that matter here are the ones nobody
// remembers: a pre-release sorts *before* the release it is a candidate for,
// and build metadata after `+` takes no part in precedence at all. Both are
// decisions this app makes about whether to interrupt somebody's afternoon.

/** A version, parsed. `raw` is what was given, without any leading `v`. */
export type Version = {
  major: number
  minor: number
  patch: number
  /** The dot-separated identifiers after `-`. Empty for a stable release. */
  prerelease: readonly (string | number)[]
  raw: string
}

/**
 * Release tags are `v` followed by the version — `scripts/release.mjs` refuses
 * anything else — so the prefix is taken off here rather than at every call
 * site, and a bare version parses just the same.
 */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** Null for anything that is not a version, which is how every refusal starts. */
export function parseVersion(raw: string): Version | null {
  const trimmed = raw.trim()
  const match = VERSION.exec(trimmed)
  if (match === null) return null
  const [, major, minor, patch, prerelease] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    // Build metadata is dropped here rather than kept and ignored later: two
    // versions differing only after `+` are the same version, and the surest
    // way that nothing ever compares it is not to carry it at all.
    prerelease: prerelease === undefined ? [] : prerelease.split('.').map(identifier),
    raw: trimmed.replace(/^v/, '')
  }
}

/** Numeric identifiers compare as numbers; everything else compares as text. */
function identifier(part: string): string | number {
  return /^\d+$/.test(part) ? Number(part) : part
}

export function isPrereleaseVersion(version: Version): boolean {
  return version.prerelease.length > 0
}

/** Negative when `a` precedes `b`, positive when it follows, zero when equal. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch

  // The rule that decides whether somebody on 0.2.0 is offered 0.2.0-rc.2: a
  // pre-release is *less* than the release it precedes. Carrying none wins.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a.prerelease[index] as string | number
    const right = b.prerelease[index] as string | number
    if (left === right) continue
    // Numeric identifiers have lower precedence than alphanumeric ones, so
    // `rc.1` follows `1` rather than sorting beside it the way text would.
    if (typeof left === 'number' && typeof right === 'number') return left - right
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  // Everything shared is equal, so the one carrying more identifiers is the
  // later of the two: `1.0.0-rc.1` precedes `1.0.0-rc.1.2`.
  return a.prerelease.length - b.prerelease.length
}

/**
 * Whether `candidate` is a version this build should be told about, and the one
 * place the pre-release rule is applied.
 *
 * Somebody running a stable build is never offered a candidate: they did not
 * ask to test anything, and a release candidate is by definition a release
 * nobody has finished. Somebody already running one has opted in by running it,
 * so for them a candidate is an ordinary upgrade.
 */
export function isNewerRelease(candidate: Version, current: Version): boolean {
  if (isPrereleaseVersion(candidate) && !isPrereleaseVersion(current)) return false
  return compareVersions(candidate, current) > 0
}
