// Deciding whether two path strings name the same checkout. macOS puts temp
// behind symlinks, Windows is case-insensitive and mixes separators, and git
// prints its own resolved spelling, so everything compares through one canonical form.

import { realpathSync } from 'node:fs'
import path from 'node:path'

/** The slice of `node:path` the pure helpers need, so `win32`/`posix` fit too. */
export type PathApi = Pick<
  typeof path,
  'resolve' | 'normalize' | 'relative' | 'isAbsolute' | 'join' | 'dirname' | 'basename' | 'parse' | 'sep'
>

/** Windows and macOS match filenames case-insensitively; Linux does not. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Symlink-resolves as much of `absolute` as exists and re-appends the rest. realpath
 * fails when the leaf is missing (normal for a checkout about to be created), and /var must still equal /private/var.
 */
export function resolveThroughAncestors(
  absolute: string,
  realpath: (target: string) => string,
  api: PathApi = path
): string {
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const resolved = realpath(current)
      return missing.length === 0 ? resolved : api.join(resolved, ...missing.reverse())
    } catch {
      const parent = api.dirname(current)
      // The root itself is unreadable: nothing left to climb.
      if (parent === current) return absolute
      missing.push(api.basename(current))
      current = parent
    }
  }
}

/** Absolute, symlink-resolved as far as the path exists, separator-normalized. */
export function canonicalPath(input: string): string {
  return resolveThroughAncestors(path.resolve(input), realpathSync.native)
}

/** Comparison key for an already-canonical path. Never shown to a user. */
export function pathKeyOf(canonical: string, platform: NodeJS.Platform, api: PathApi = path): string {
  const trimmed = stripTrailingSeparators(api.normalize(canonical), api)
  return isCaseInsensitivePlatform(platform) ? trimmed.toLowerCase() : trimmed
}

/** Comparison key. Never show this to a user; show the recorded path instead. */
export function pathKey(input: string): string {
  return pathKeyOf(canonicalPath(input), process.platform)
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** Containment on two keys from `pathKeyOf`, which have already been case-folded. */
export function isInsideKeys(parentKey: string, childKey: string, api: PathApi = path): boolean {
  if (parentKey === childKey) return false
  const relative = api.relative(parentKey, childKey)
  if (relative === '' || relative === '..') return false
  return !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)
}

/**
 * True when `child` is inside `parent`, used to gate destructive cleanup.
 * Folded through `pathKey` so it agrees with `samePath` about case and symlinks.
 */
export function isInside(parent: string, child: string): boolean {
  return isInsideKeys(pathKey(parent), pathKey(child))
}

/** Drops trailing separators without eating the root, so `C:\` stays `C:\`. */
function stripTrailingSeparators(value: string, api: PathApi): string {
  const root = api.parse(value).root
  let end = value.length
  while (end > root.length && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1
  return value.slice(0, end)
}
