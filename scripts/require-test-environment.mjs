// Refuses to start the suite in a checkout that cannot run all of it.
//
// A run that ends "1952 passed" is read as "the project is proven", and for a
// long time it was not: several of this project's strongest tests decide for
// themselves whether to run, by looking for something on disk and skipping when
// it is absent. `relayProcess.test.ts` and `relayWatch.test.ts` spawn the built
// relay and drive real WebSockets through it — they are the only tests that
// prove teamwork end to end rather than against a fake. The seven PTY suites
// fork a real pty — this is a terminal application, and a run that could not
// open a terminal is not a pass. Both groups skip on an absence, and a skip
// nobody sees is a test that does not exist.
//
// This used to say so only when `CI` was set. That was the wrong way round:
// with GitHub Actions switched off for this repository, a local `npm test` is
// the only gate there is, and it was the one run where the check printed a
// warning into the middle of a minute of vitest output and exited 0.
//
// So the rule here is that an absence is never inferred. Every refusal below
// names the command that fixes it, and every one of them can be stood down —
// but only by typing the opt-out, never by lacking something:
//
//   TEAMREE_SKIP_RELAY_TESTS=1   the relay package is not built or installed
//                                here, and the peer tests that drive it, plus
//                                the relay's own suite, are to be left out.
//   TEAMREE_SKIP_PTY_TESTS=1     this machine cannot fork a pty, and the seven
//                                terminal suites are to be left out.
//
// `scripts/vitest-skip-allowlist.mjs` reads the same two variables and is what
// makes them honest: it fails the run on any skip that is not accounted for, so
// opting out here shows up there as a permitted absence rather than as silence.
// It carries a third variable of its own, TEAMREE_SKIP_WORKERD_TESTS=1, for the
// relay's two Worker suites. That one is not checked here because the relay's
// own `workerdUnavailable()` already says precisely why the runtime is missing,
// and restating it would be two answers to one question.
//
// Two entry points, one implementation: `pretest` runs this file as a script,
// and `vitest.config.ts` names it as a globalSetup so that `npx vitest run`
// cannot start a quieter suite than `npm test` would.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const RELAY_ROOT = join(REPO_ROOT, 'relay')
const RELAY_SRC = join(RELAY_ROOT, 'src')
const RELAY_DIST = join(RELAY_ROOT, 'dist')
/** Exactly the path the peer tests resolve and stat before deciding to run. */
const RELAY_ENTRY = join(RELAY_DIST, 'node', 'index.js')
/** The other input to `tsc -p tsconfig.json`, and the other way dist goes stale. */
const RELAY_TSCONFIG = join(RELAY_ROOT, 'tsconfig.json')

const INSTALL_IT = 'cd relay && npm ci'
const BUILD_IT = 'cd relay && npm run build'

const skipRelay = process.env.TEAMREE_SKIP_RELAY_TESTS === '1'
const skipPtys = process.env.TEAMREE_SKIP_PTY_TESTS === '1'

/** The newest mtime anywhere under `directory`, or 0 if it holds no files. */
function newestMtime(directory) {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/**
 * Why the relay under test is not the relay in the tree, or null when it is.
 *
 * `relay/dist` is gitignored, so it is per-machine state no commit keeps in
 * step, and nothing in the root `npm run build` touches it. Editing
 * `relay/src/**` and running `npm test` therefore used to be green with every
 * relay test driving the previously built relay — a pass that says nothing
 * about the code that was changed.
 */
function relayBuildDrift() {
  if (!existsSync(RELAY_DIST)) return null
  const built = newestMtime(RELAY_DIST)
  const newestInput = Math.max(newestMtime(RELAY_SRC), statSync(RELAY_TSCONFIG).mtimeMs)
  if (newestInput <= built) return null
  return `${relative(REPO_ROOT, RELAY_SRC)} has changed since ${relative(REPO_ROOT, RELAY_DIST)} was built`
}

/**
 * Whether a pty can be forked here.
 *
 * Deliberately the same two-line probe as `canSpawnPty()` in
 * `src/main/terminals/pty-test-support.ts`, rather than an import of it: that
 * file is TypeScript the suite loads through vite, and this runs as a plain
 * script before vite exists. Keep the pair in step — what is being asked is
 * "does node-pty work at all here", and the answer has to be the same one the
 * suites will get.
 */
function ptyFailure() {
  const require = createRequire(import.meta.url)
  const probe =
    process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'exit 0']]
      : ['/bin/sh', ['-c', 'exit 0']]
  try {
    const { spawn } = require('node-pty')
    const pty = spawn(probe[0], probe[1], {
      name: 'xterm-256color',
      cwd: REPO_ROOT,
      cols: 20,
      rows: 5,
      env: { ...process.env }
    })
    try {
      pty.kill()
    } catch {
      // Already exited; the fork itself is what was being proved.
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Every reason the suite would run less than it claims, as a block of prose. */
function refusals() {
  const found = []

  if (!skipRelay) {
    if (!existsSync(join(RELAY_ROOT, 'node_modules'))) {
      found.push(
        'The relay has no node_modules, so neither the peer tests that spawn it nor its own\n' +
          `suite can run. Install it with:  ${INSTALL_IT}`
      )
    } else if (!existsSync(RELAY_ENTRY)) {
      found.push(
        `${relative(REPO_ROOT, RELAY_ENTRY)} is not there, so the tests that drive the real\n` +
          'relay would skip — and those are the only ones that prove teamwork against the relay\n' +
          `rather than against a fake. Build it with:  ${BUILD_IT}`
      )
    } else {
      const drift = relayBuildDrift()
      if (drift !== null) {
        found.push(
          `${drift}, so the relay tests would run against the\n` +
            'previously built relay and say nothing about the change. Rebuild it with:  ' +
            BUILD_IT
        )
      }
    }
  }

  if (!skipPtys) {
    const failure = ptyFailure()
    if (failure !== null) {
      found.push(
        'A pty could not be forked here, so the seven terminal suites would skip and this run\n' +
          'would say nothing about the part of teamree that is a terminal. node-pty said:\n' +
          `  ${failure}\n` +
          'A missing or wrong-architecture prebuild, or a spawn-helper that is not executable,\n' +
          'is usually repaired by reinstalling:  npm ci'
      )
    }
  }

  return found
}

/** The same refusals, with the way past each of them spelled out underneath. */
function report(found) {
  return [
    'require-test-environment: this checkout cannot run the whole suite.',
    '',
    ...found.map((reason) => `${reason}\n`),
    'Each of these can be stood down deliberately, by setting TEAMREE_SKIP_RELAY_TESTS=1 or',
    'TEAMREE_SKIP_PTY_TESTS=1 — which says out loud, in the run and in the skip allowlist, that',
    'those tests were left out. Nothing is left out by being absent.'
  ].join('\n')
}

/** Named as a vitest globalSetup, so the check runs however the suite is started. */
export default function requireTestEnvironment() {
  const found = refusals()
  if (found.length > 0) throw new Error(report(found))
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const found = refusals()
  if (found.length > 0) {
    console.error(report(found))
    process.exit(1)
  }
}
