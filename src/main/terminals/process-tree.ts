// Killing a pane means killing everything it started.
//
// An agent CLI in a pane spawns compilers, test runners and language servers.
// Signalling only the direct child leaves those running with the PTY master
// closed, so they survive the app and keep holding the worktree. On unix the PTY
// child is a session leader, which makes its pid a process-group id: signalling
// the negated pid reaches the whole group. Windows has no equivalent, so taskkill
// walks the tree instead.
//
// Every OS call goes through `ProcessTreeHost` so the escalation can be driven
// for all three platforms from one machine.

import { execFile } from 'node:child_process'

/** How long a process tree gets to honour SIGHUP before SIGKILL. */
export const KILL_ESCALATION_MS = 2_000

const LIVENESS_POLL_MS = 25

export type ProcessTreeHost = {
  /** Mirrors `process.kill`: throws with an errno code when it cannot deliver. */
  kill(target: number, signal: NodeJS.Signals | 0): void
  /** Terminates the whole tree rooted at `pid` on Windows. */
  killWindowsTree(pid: number): Promise<void>
  delay(ms: number): Promise<void>
  now(): number
}

/**
 * taskkill is addressed absolutely: an Electron app can inherit a PATH without
 * System32 on it, and a silently missing taskkill would orphan the whole tree.
 * `windowsHide` keeps a console window from flashing over the app on every close.
 */
export function resolveTaskkill(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT']
  return systemRoot ? `${systemRoot}\\System32\\taskkill.exe` : 'taskkill.exe'
}

export const defaultProcessTreeHost: ProcessTreeHost = {
  kill: (target, signal) => {
    process.kill(target, signal)
  },
  killWindowsTree: (pid) =>
    new Promise((resolve) => {
      // A non-zero exit here is the already-exited case, which is not an error.
      execFile(resolveTaskkill(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now()
}

/**
 * Terminates the process tree rooted at `pid`. Resolves once the root is gone or
 * the escalation has been issued; a tree that has already exited is a no-op.
 */
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  escalationMs: number = KILL_ESCALATION_MS,
  host: ProcessTreeHost = defaultProcessTreeHost
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return

  if (platform === 'win32') {
    // Nothing to walk, and taskkill on a recycled pid would hit a stranger.
    if (!isProcessAlive(pid, host)) return
    await host.killWindowsTree(pid)
    await waitForExit(pid, escalationMs, host)
    return
  }

  // SIGHUP first: a shell treats it as the terminal going away and runs its own
  // exit path, which is what lets child processes clean up.
  if (!signalTree(pid, 'SIGHUP', host)) return
  if (await waitForExit(pid, escalationMs, host)) return
  signalTree(pid, 'SIGKILL', host)
  await waitForExit(pid, escalationMs, host)
}

/** True when the process still exists. A pid we may not signal counts as alive. */
export function isProcessAlive(pid: number, host: ProcessTreeHost = defaultProcessTreeHost): boolean {
  try {
    host.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

/** Returns false when there was nothing left to signal. */
function signalTree(pid: number, signal: NodeJS.Signals, host: ProcessTreeHost): boolean {
  let reached = false
  try {
    host.kill(-pid, signal)
    reached = true
  } catch (error) {
    // ESRCH here means no such group: the child may still exist without being a
    // group leader, so fall through to the direct signal rather than give up.
    if (errorCode(error) === 'EPERM') reached = true
  }

  try {
    host.kill(pid, signal)
    reached = true
  } catch (error) {
    if (errorCode(error) === 'EPERM') reached = true
  }

  return reached
}

async function waitForExit(pid: number, timeoutMs: number, host: ProcessTreeHost): Promise<boolean> {
  const deadline = host.now() + timeoutMs
  while (host.now() < deadline) {
    if (!isProcessAlive(pid, host)) return true
    await host.delay(LIVENESS_POLL_MS)
  }
  return !isProcessAlive(pid, host)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
