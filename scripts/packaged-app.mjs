// Which packaged app a verification script should look at.
//
// One copy, imported by both scripts/verify-package.mjs and
// scripts/verify-quarantine-advice.mjs, because they had a copy each and both
// copies were wrong in the same way — which is what a copy does.
//
// electron-builder does not clean `dist/` between runs, and a universal build
// removes its own per-architecture intermediates once it has merged them. So a
// `dist/mac/` or `dist/mac-arm64/` left behind by any earlier single-
// architecture build stays there permanently, and a fixed order that named it
// before `dist/mac-universal/` would verify the old app, report PASS, and leave
// somebody shipping a `.dmg` nothing had looked at. `install:verify` would go
// further and copy the stale bundle into /Applications.
//
// Which one exists is the wrong question; which one was just built is the right
// one. So the newest wins, read off the bundle's own executable, which every
// pack rewrites. A fixed order cannot be right for both kinds of build: naming
// the universal app first has the mirror of the same fault, quietly checking a
// stale universal bundle for somebody who has just built a single-architecture
// one with `package:dir`.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every place a packaged app lands, newest first.
 *
 * Ties — two builds within the same millisecond, or a tree whose executable
 * cannot be stat'd — fall back to the order written here, universal first,
 * because the universal `.dmg` is the only macOS artifact this project ships.
 */
export function packagedAppCandidates(platform = process.platform) {
  const candidates =
    platform === 'darwin'
      ? ['dist/mac-universal/teamree.app', 'dist/mac-arm64/teamree.app', 'dist/mac/teamree.app']
      : platform === 'win32'
        ? ['dist/win-unpacked']
        : ['dist/linux-unpacked']

  return candidates
    .map((root, order) => ({ root, order, built: builtAt(root, platform) }))
    .sort((a, b) => b.built - a.built || a.order - b.order)
    .map((entry) => entry.root)
}

/** When this tree was last packed, as the mtime of the executable in it. */
function builtAt(root, platform) {
  const binary =
    platform === 'darwin'
      ? join(root, 'Contents', 'MacOS', 'teamree')
      : join(root, platform === 'win32' ? 'teamree.exe' : 'teamree')
  // The bundle directory is the fallback rather than the first choice: adding a
  // file inside Contents/ does not touch the mtime of the directory above it.
  for (const path of [binary, root]) {
    try {
      return statSync(path).mtimeMs
    } catch {
      // Not packed here, or not packed fully. Try the next.
    }
  }
  return 0
}

/** The newest packaged app present, or undefined if none is. */
export function findPackagedApp(platform = process.platform) {
  return packagedAppCandidates(platform).find((candidate) => existsSync(candidate))
}
