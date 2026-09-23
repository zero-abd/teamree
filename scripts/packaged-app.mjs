// Which packaged app a verification script should look at: the newest, by its executable's mtime.
// electron-builder never cleans `dist/`, so a fixed order verifies a stale build for one kind or the other.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every place a packaged app lands, newest first; ties go universal first, the only shipped .dmg. */
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
  // The directory is the fallback: adding a file in Contents/ does not touch its mtime.
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
