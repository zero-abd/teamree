// Deciding whether two path strings name the same checkout.
//
// This is harder than string equality on every platform we ship to: macOS puts
// temp and /var behind symlinks, Windows is case-insensitive and mixes
// separators, and git prints its own resolved spelling in `worktree list`.
// Records and git output are therefore compared through one canonical form.

import { realpathSync } from 'node:fs'
import path from 'node:path'

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** Absolute, symlink-resolved where the path exists, separator-normalized. */
export function canonicalPath(input: string): string {
  const absolute = path.resolve(input)
  try {
    return realpathSync.native(absolute)
  } catch {
    // Not on disk yet (a worktree we are about to create) or unreadable: the
    // resolved-but-unfollowed form is still a usable identity.
    return absolute
  }
}

/** Comparison key. Never show this to a user; show the recorded path instead. */
export function pathKey(input: string): string {
  const canonical = canonicalPath(input)
  const normalized = path.normalize(canonical).replace(/[\\/]+$/, '')
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** True when `child` is inside `parent`, used to gate destructive cleanup. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
