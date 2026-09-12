// Killing a pane's process tree, which has no common mechanism across the three
// platforms: POSIX signals a process group, Windows walks the tree with
// taskkill. The decision logic is driven through an injected host so both paths
// are asserted from one machine, and the POSIX path is then run for real.

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

  it('kills the whole tree, forcibly, without showing a console', async () => {
    execFileCalls.length = 0
    await defaultProcessTreeHost.killWindowsTree(4242)
    expect(execFileCalls).toHaveLength(1)
    expect(execFileCalls[0]?.args).toEqual(['/PID', '4242', '/T', '/F'])
    expect(execFileCalls[0]?.options).toEqual({ windowsHide: true })
  })
})

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
