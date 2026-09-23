// Comparing two version strings. No string comparison anywhere: `'0.10.0' >
// '0.9.0'` is false. A pre-release sorts *before* its release, and build
// metadata after `+` takes no part in precedence.

/** A version, parsed. `raw` is what was given, without any leading `v`. */
export type Version = {
  major: number
  minor: number
  patch: number
  /** The dot-separated identifiers after `-`. Empty for a stable release. */
  prerelease: readonly (string | number)[]
  raw: string
}

/** Release tags are `v` plus the version (`scripts/release.mjs` refuses anything else); a bare version parses too. */
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
    // Build metadata is dropped: the surest way nothing compares it.
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

  // A pre-release is *less* than the release it precedes.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a.prerelease[index] as string | number
    const right = b.prerelease[index] as string | number
    if (left === right) continue
    // Numeric identifiers have lower precedence than alphanumeric ones.
    if (typeof left === 'number' && typeof right === 'number') return left - right
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  // `1.0.0-rc.1` precedes `1.0.0-rc.1.2`.
  return a.prerelease.length - b.prerelease.length
}

/** Whether `candidate` is worth telling this build about; a stable build is never offered a candidate. */
export function isNewerRelease(candidate: Version, current: Version): boolean {
  if (isPrereleaseVersion(candidate) && !isPrereleaseVersion(current)) return false
  return compareVersions(candidate, current) > 0
}
