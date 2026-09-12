// Shared by the tests that spawn real PTYs.
//
// node-pty is a native module: on a machine where the prebuilt binary or the
// spawn helper is unusable, every PTY test would otherwise hang on a promise
// that never settles. The probe answers "can this environment fork a pty at
// all" once, cheaply, so those suites can skip instead.

import { spawn } from 'node-pty'

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
  } catch {
    return false
  }
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
