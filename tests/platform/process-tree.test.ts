// Killing a pane's process tree, which has no common mechanism across the three
// platforms: POSIX signals a process group, Windows walks the tree with
// taskkill. The decision logic is driven through an injected host so both paths
// are asserted from one machine, and the POSIX path is then run for real.
//
// The two platforms are not equally covered, and the difference is easy to miss
// in a file where every describe block is green, so it is stated here:
//
//   POSIX   is decided against a fake host below and then actually carried out.
//           `the real POSIX process group` spawns a shell, spawns a grandchild
//           under it, kills the tree, and waits for the grandchild to be reaped.
//           That block is the evidence that closing a pane does not orphan an
//           agent.
//   Windows is decided only. `execFile` is replaced at the top of this file, so
//           no taskkill is ever launched and nothing is ever killed; the Windows
//           cases establish which branch is taken and what command line would be
//           built, and that is all they establish. The one block that kills a
//           real process is skipped on win32, so on a Windows runner this file
//           would say nothing about whether a pane orphans anything.
//
// That asymmetry is left in place rather than closed. Windows was deliberately
// dropped — see the matrix comment in .github/workflows/build.yml — and the app
// ships macOS-only, so a real Windows test would be one nothing in this project
// can run: another green block proving nothing, which is what the rest of this
// file is being careful not to be. A file that says plainly where the evidence
// stops is worth more here than a test that would only ever be skipped.

import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const execFileCalls: Array<{ file: string; args: readonly string[]; options: unknown }> = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: readonly string[], options: unknown, callback: () => void) => {
      execFileCalls.push({ file, args, options })
      callback()
      return undefined
    }
  }
})

const { defaultProcessTreeHost, isProcessAlive, killProcessTree, resolveTaskkill } = await import(
  '../../src/main/terminals/process-tree'
)
type ProcessTreeHost = Parameters<typeof killProcessTree>[3]

type Signalled = { target: number; signal: NodeJS.Signals | 0 }

/**
 * A process that is alive until `diesAfter` signals have reached it, recording
 * every delivery. Liveness probes (signal 0) are not counted as deliveries.
 */
function fakeHost(options: { alive?: boolean; diesAfterSignals?: number; permissionDenied?: boolean } = {}): {
  host: ProcessTreeHost
  signals: Signalled[]
  windowsKills: number[]
} {
  const signals: Signalled[] = []
  const windowsKills: number[] = []
  let alive = options.alive ?? true
  let delivered = 0
  let clock = 0

  const host: ProcessTreeHost = {
    kill: (target, signal) => {
      if (signal !== 0) signals.push({ target, signal })
      if (options.permissionDenied) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      if (signal === 0) return
      delivered += 1
      if (options.diesAfterSignals !== undefined && delivered >= options.diesAfterSignals) alive = false
    },
    killWindowsTree: (pid) => {
      windowsKills.push(pid)
      alive = false
      return Promise.resolve()
    },
    delay: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    now: () => clock
  }

  return { host, signals, windowsKills }
}

describe('killProcessTree on POSIX', () => {
  it('signals the whole group first, and the process as well', async () => {
    const { host, signals } = fakeHost({ diesAfterSignals: 1 })
    await killProcessTree(4242, 'linux', 50, host)
    // The group leads; the direct signal covers a child that never became one.
    expect(signals).toEqual([
      { target: -4242, signal: 'SIGHUP' },
      { target: 4242, signal: 'SIGHUP' }
    ])
    expect(signals.some((entry) => entry.signal === 'SIGKILL')).toBe(false)
  })

  it('escalates to SIGKILL when the tree ignores SIGHUP', async () => {
    const { host, signals } = fakeHost()
    await killProcessTree(4242, 'darwin', 100, host)
    expect(signals.map((entry) => entry.signal)).toEqual(['SIGHUP', 'SIGHUP', 'SIGKILL', 'SIGKILL'])
    expect(signals.map((entry) => entry.target)).toEqual([-4242, 4242, -4242, 4242])
  })

  it('does not escalate against a tree that has already exited', async () => {
    const { host, signals, windowsKills } = fakeHost({ alive: false })
    await killProcessTree(4242, 'linux', 100, host)
    expect(signals.map((entry) => entry.signal)).toEqual(['SIGHUP', 'SIGHUP'])
    expect(windowsKills).toEqual([])
  })

  it('treats a pid it may not signal as alive rather than as gone', async () => {
    const { host, signals } = fakeHost({ permissionDenied: true })
    expect(isProcessAlive(1, host)).toBe(true)
    await killProcessTree(1, 'linux', 10, host)
    expect(signals.map((entry) => entry.signal)).toContain('SIGKILL')
  })

  it('refuses a pid that could not name a process', async () => {
    const { host, signals, windowsKills } = fakeHost()
    for (const pid of [0, -1, 1.5, Number.NaN]) await killProcessTree(pid, 'linux', 10, host)
    expect(signals).toEqual([])
    expect(windowsKills).toEqual([])
  })
})

// Decision only, via the injected host: `killWindowsTree` records a pid and
// flips a boolean. What is proven is the branch — taskkill rather than signals,
// and nothing at all against a pid that has already gone — never that a tree
// came down.
describe('killProcessTree on Windows', () => {
  it('walks the tree with taskkill and sends no POSIX signal', async () => {
    const { host, signals, windowsKills } = fakeHost()
    await killProcessTree(4242, 'win32', 50, host)
    expect(windowsKills).toEqual([4242])
    // A negative pid is EINVAL on Windows; nothing may reach process.kill.
    expect(signals).toEqual([])
  })

  it('leaves a pid that has already gone alone, so a recycled one is never hit', async () => {
    const { host, windowsKills } = fakeHost({ alive: false })
    await killProcessTree(4242, 'win32', 50, host)
    expect(windowsKills).toEqual([])
  })
})

describe('taskkill', () => {
  // The defect: taskkill was addressed by bare name and without windowsHide, so
  // a PATH missing System32 silently orphaned the tree, and every pane close
  // flashed a console window over the app.
  it('is addressed under SystemRoot when Windows says where that is', () => {
    expect(resolveTaskkill({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(resolveTaskkill({ SYSTEMROOT: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe')
    expect(resolveTaskkill({})).toBe('taskkill.exe')
  })

  // Named for what it checks. `execFile` is mocked at the top of this file, so
  // this is the command line the app would hand Windows, not a kill: no process
  // is launched and nothing dies. It is still worth having — the defect above
  // was in exactly these four arguments and this one option — but it is a
  // string comparison, and on Windows it is the only Windows evidence there is.
  it('builds the command line that takes the whole tree, forcibly, with no console', async () => {
    execFileCalls.length = 0
    await defaultProcessTreeHost.killWindowsTree(4242)
    expect(execFileCalls).toHaveLength(1)
    expect(execFileCalls[0]?.args).toEqual(['/PID', '4242', '/T', '/F'])
    expect(execFileCalls[0]?.options).toEqual({ windowsHide: true })
  })
})

// The only block here that kills a real process, and the only one whose passing
// depends on the operating system having actually done something. It is skipped
// on win32 because a process group is a POSIX idea; see the header for what that
// leaves unproven there.
describe.skipIf(process.platform === 'win32')('the real POSIX process group', () => {
  const pidIsAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  it('takes a grandchild down with the shell that started it', async () => {
    // detached makes the shell a session leader, so its pid doubles as the
    // process-group id every descendant inherits.
    const child = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })

    const grandchild = await new Promise<number>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.once('data', (chunk: string) => resolve(Number.parseInt(chunk.trim(), 10)))
      child.once('error', reject)
    })

    expect(Number.isInteger(grandchild)).toBe(true)
    expect(pidIsAlive(grandchild)).toBe(true)

    await killProcessTree(child.pid as number, process.platform, 2_000)

    await waitUntil(() => !pidIsAlive(grandchild), 'the grandchild to be reaped')
    expect(pidIsAlive(grandchild)).toBe(false)
  })

  it('is a no-op against a pid nothing owns', async () => {
    const gone = 0x7ffffff0
    expect(pidIsAlive(gone)).toBe(false)
    await expect(killProcessTree(gone, process.platform, 50)).resolves.toBeUndefined()
  })
})
