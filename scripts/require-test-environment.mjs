// Refuses to start the suite in a checkout that cannot run all of it: the relay tests and the seven
// PTY suites skip on an absence, and a skip nobody sees is a test that does not exist. An absence is
// never inferred; only TEAMREE_SKIP_RELAY_TESTS=1 / TEAMREE_SKIP_PTY_TESTS=1 stand a refusal down, and
// `scripts/vitest-skip-allowlist.mjs` reads the same two so the opt-out is a permitted absence there.
// Run by `pretest` as a script and by `vitest.config.ts` as a globalSetup, so `npx vitest run` is no quieter.

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
 * Why the relay under test is not the relay in the tree, or null. `relay/dist` is gitignored and the
 * root build never touches it, so an edit to `relay/src` would otherwise test the previous build.
 */
function relayBuildDrift() {
  if (!existsSync(RELAY_DIST)) return null
  const built = newestMtime(RELAY_DIST)
  const newestInput = Math.max(newestMtime(RELAY_SRC), statSync(RELAY_TSCONFIG).mtimeMs)
  if (newestInput <= built) return null
  return `${relative(REPO_ROOT, RELAY_SRC)} has changed since ${relative(REPO_ROOT, RELAY_DIST)} was built`
}

/**
 * Whether a pty can be forked here. The same probe as `canSpawnPty()` in
 * `src/main/terminals/pty-test-support.ts`, copied because this runs before vite exists; keep in step.
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
