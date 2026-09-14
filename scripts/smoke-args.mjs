// What `run-smoke.mjs` has to tell the Electron process it launches, and how.
//
// It used to tell it one thing — where the peer bundle is — as a bare
// positional argument, read back as `process.argv[2]`. Counting positions only
// works while nothing else is on the command line, and something else is:
// `electronSandboxArgs()` prepends `--no-sandbox` when the run is root on
// Linux, Electron leaves that switch in `process.argv`, and argv[2] then named
// the smoke script rather than the bundle. The check duly reported that it
// could not import the peer library — which is exactly what it would have said
// if the peer library were broken.
//
// So these are named rather than counted. A flag read by name cannot be
// displaced by anything added beside it, which is the property a position never
// had, and the spellings live here so that the launcher writing them and the
// scripts reading them cannot drift apart.

/** Where `buildPeerBundle()` wrote the compiled peer library. */
export const PEER_BUNDLE_FLAG = '--peer-bundle'

/**
 * The throwaway user data directory the app is to run against.
 *
 * Named by the launcher rather than made by the app, because the launcher is
 * what is still running when Electron has exited, and Chromium writes its
 * profile out during shutdown — a directory the app deletes on its own way out
 * is a directory that comes back.
 *
 * Named, and deliberately not created: the launcher makes the directory *above*
 * it and leaves this one to Electron, so that the mode the smoke test reads off
 * it is the one the app would have on a first launch.
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
