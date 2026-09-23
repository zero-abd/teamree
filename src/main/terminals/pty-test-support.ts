// Shared by the tests that spawn real PTYs. A broken node-pty would hang every
// PTY test, so the probe lets them skip; `scripts/require-test-environment.mjs`
// and `scripts/vitest-skip-allowlist.mjs` stop that skip passing silently.

import { chmod, writeFile } from 'node:fs/promises'
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
    // Said out loud: this is the only trace a broken node-pty leaves in a run.
    console.warn(
      `canSpawnPty: no pty could be forked, so the PTY suites will skip — ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return false
  }
}

/** The shell a test pane should be opened with: the app's own rule, not a second one. */
export function testShell(): string {
  return resolveLoginShell()
}

/** `text` on a line, then an exit with `code`, spelled for this platform's shell. */
export function printThenExit(text: string, code: number): string {
  // cmd.exe reads `;` as part of the argument and would print it.
  return shellFamily(testShell()) === 'cmd' ? `echo ${text}& exit ${code}` : `echo ${text}; exit ${code}`
}

/**
 * A command that starts a process of its own, prints its pid, and keeps both
 * alive. A script file, so no quoting has to survive both cmd.exe and a POSIX shell.
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
  // Quoted: Windows paths have separators a POSIX shell reads as escapes, and a temp dir may hold a space.
  return `"${process.execPath}" "${script}"`
}

/**
 * A program `detectAgent` will recognise as `claude` (by basename), which prints
 * its arguments so a test can see which session id the launch carried. Quoted.
 */
export async function writeFakeAgent(directory: string, exitCode = 0): Promise<string> {
  if (process.platform === 'win32') {
    const batch = path.join(directory, 'claude.cmd')
    await writeFile(batch, `@echo off\r\necho agent args: %*\r\nexit /b ${exitCode}\r\n`, 'utf8')
    return `"${batch}"`
  }
  const script = path.join(directory, 'claude')
  await writeFile(script, `#!/bin/sh\necho "agent args: $@"\nexit ${exitCode}\n`, 'utf8')
  await chmod(script, 0o755)
  return `"${script}"`
}

/** Polls `condition` until it holds, rejecting on timeout with a readable message. */
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
