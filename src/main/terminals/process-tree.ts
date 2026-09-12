// Killing a pane means killing everything it started.
//
// An agent CLI in a pane spawns compilers, test runners and language servers.
// Signalling only the direct child leaves those running with the PTY master
// closed, so they survive the app and keep holding the worktree. On unix the PTY
// child is a session leader, which makes its pid a process-group id: signalling
// the negated pid reaches the whole group. Windows has no equivalent, so taskkill
// walks the tree instead.

import { execFile } from 'node:child_process'

/** How long a process tree gets to honour SIGHUP before SIGKILL. */
export const KILL_ESCALATION_MS = 2_000

const LIVENESS_POLL_MS = 25

/**
 * Terminates the process tree rooted at `pid`. Resolves once the root is gone or
 * the escalation has been issued; a tree that has already exited is a no-op.
 */
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  escalationMs: number = KILL_ESCALATION_MS
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return

  if (platform === 'win32') {
    await killWindowsTree(pid)
    return
  }

  // SIGHUP first: a shell treats it as the terminal going away and runs its own
  // exit path, which is what lets child processes clean up.
  if (!signalTree(pid, 'SIGHUP')) return
  if (await waitForExit(pid, escalationMs)) return
  signalTree(pid, 'SIGKILL')
  await waitForExit(pid, escalationMs)
}

/** True when the process still exists. A pid we may not signal counts as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

/** Returns false when there was nothing left to signal. */
function signalTree(pid: number, signal: NodeJS.Signals): boolean {
  let reached = false
  try {
    process.kill(-pid, signal)
    reached = true
  } catch (error) {
    // ESRCH here means no such group: the child may still exist without being a
    // group leader, so fall through to the direct signal rather than give up.
    if (errorCode(error) === 'EPERM') reached = true
  }

  try {
    process.kill(pid, signal)
    reached = true
  } catch (error) {
    if (errorCode(error) === 'EPERM') reached = true
  }

  return reached
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await delay(LIVENESS_POLL_MS)
  }
  return !isProcessAlive(pid)
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    // A non-zero exit here is the already-exited case, which is not an error.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
