// Shared by the tests that spawn real PTYs.
//
// node-pty is a native module: on a machine where the prebuilt binary or the
// spawn helper is unusable, every PTY test would otherwise hang on a promise
// that never settles. The probe answers "can this environment fork a pty at
// all" once, cheaply, so those suites can skip instead.
//
// Skipping is not on its own an acceptable answer, though — seven suites, sixty
// tests, vanishing out of a green run. `scripts/require-test-environment.mjs`
// asks this same question before the suite starts and refuses to run without a
// pty unless TEAMREE_SKIP_PTY_TESTS=1 says so deliberately, and
// `scripts/vitest-skip-allowlist.mjs` fails the run if these suites skip
// without it. What is left here is the skip itself, and saying why.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node-pty'
import { resolveLoginShell, shellFamily } from './shell-environment'

const PROBE_COLS = 20
const PROBE_ROWS = 5

export function ptyProbeCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'exit 0'] }
  }
  return { file: '/bin/sh', args: ['-c', 'exit 0'] }
}

export function canSpawnPty(): boolean {
  const { file, args } = ptyProbeCommand()
  try {
    const probe = spawn(file, args, {
      name: 'xterm-256color',
      cwd: process.cwd(),
      cols: PROBE_COLS,
      rows: PROBE_ROWS,
      env: { ...process.env } as Record<string, string>
    })
    try {
      probe.kill()
    } catch {
      // Already exited; the fork itself is what was being proved.
    }
    return true
  } catch (error) {
    // Said out loud. A bare `false` was the whole of this branch once, and it
    // was the only trace a broken node-pty left anywhere in a run: the reason
    // the suites did not run was known here and thrown away here.
    console.warn(
      `canSpawnPty: no pty could be forked, so the PTY suites will skip — ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return false
  }
}

/**
 * The shell a test pane should be opened with: the one this platform has.
 *
 * A test names a shell only because PtySession asks for one, and a name picked
 * by hand is a second rule about default shells that can disagree with the
 * app's. This is the app's rule, called from the test.
 */
export function testShell(): string {
  return resolveLoginShell()
}

/** `text` on a line, then an exit with `code`, spelled for this platform's shell. */
export function printThenExit(text: string, code: number): string {
  // `;` separates commands everywhere a pane can land except cmd.exe, which
  // reads it as part of the argument and would print it instead.
  return shellFamily(testShell()) === 'cmd' ? `echo ${text}& exit ${code}` : `echo ${text}; exit ${code}`
}

/**
 * A command that starts a process of its own, prints its pid, and then keeps
 * both alive — the shape a process-tree kill has to reach through.
 *
 * A script file rather than an inline program: the quoting that would survive
 * both cmd.exe and a POSIX shell is its own puzzle, and what is under test is
 * the killing, not the quoting. Returns the command line to run it with.
 */
export async function writeProcessTreeProbe(directory: string): Promise<string> {
  const script = path.join(directory, 'grandchild.cjs')
  await writeFile(
    script,
    "const { spawn } = require('node:child_process')\n" +
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })\n" +
      "console.log('child:' + child.pid)\n" +
      'setInterval(() => {}, 1000)\n',
    'utf8'
  )
  // Quoted both sides: a Windows runner puts node under a path with separators
  // a POSIX shell would read as escapes, and either shell may hand a pane a
  // temp directory with a space in it.
  return `"${process.execPath}" "${script}"`
}

/** Polls `condition` until it holds, rejecting on timeout so a test fails fast
 *  with a readable message rather than hanging until the runner gives up. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${description}`)
}
