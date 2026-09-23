// What `run-smoke.mjs` tells the Electron process it launches. Named flags, not positions:
// `--no-sandbox` prepended on root Linux once shifted argv[2] and faked a broken peer library.

/** Where `buildPeerBundle()` wrote the compiled peer library. */
export const PEER_BUNDLE_FLAG = '--peer-bundle'

/**
 * The throwaway user data directory, named by the launcher (Chromium writes its profile during shutdown)
 * and left for Electron to create, so its mode is a first launch's.
 */
export const USER_DATA_FLAG = '--smoke-user-data'

/** The argument to pass for `flag`. */
export function namedArg(flag, value) {
  return `${flag}=${value}`
}

/** The value `flag` was given, or undefined when it was not passed. */
export function readNamedArg(flag, argv = process.argv) {
  const prefix = `${flag}=`
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

/**
 * A git repository for the window to open, made by the launcher so a fixture failure does not read as
 * a broken window. Optional: without one the worktree checks are skipped.
 */
export const FIXTURE_REPO_FLAG = '--fixture-repo'
