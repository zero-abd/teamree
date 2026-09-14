// ⌘Q pressed in the second before the app has finished starting.
//
// The window is real and it is narrow. `startRuntime` restores the panes of the
// last session — a pty per recorded pane, agents resumed — and only then binds
// the CLI socket, writes the discovery file and installs the renderer bridge,
// and only then hands back the handle whose `stop` can kill any of it. A quit
// let through in between ends the process with those panes still running: they
// die of a master fd closing under them rather than of a kill, which is the one
// death that writes no transcript.
//
// So this is the real thing rather than a fake of it: a real workspace file
// naming a real pane, a real pty brought back from it, a real scrollback
// archive, and a quit fired while the runtime handle is still undefined. What
// is asserted is what the user would find afterwards — the pane's process gone,
// and what it printed on disk where the next launch will look for it.

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuitSequence } from './quitSequence'
import { startRuntime, WORKSPACE_FILE_NAME, type Runtime } from './runtime/startRuntime'
import { SCROLLBACK_DIR_NAME } from './store/scrollbackArchive'
import { WorkspaceStore } from './store/workspaceStore'
import { canSpawnPty, testShell, waitUntil } from './terminals/pty-test-support'

// The renderer bridge is the last thing a launch does, and the one step after
// the panes are back that can genuinely throw: `ipcMain.handle` refuses a
// channel that is already taken. Standing in for it here is a module that
// refuses on demand, so that "the launch failed" can be a fact of a test rather
// than a wait for the day it happens. The gate is what makes the failure land
// after the restored pane is up, which is the only moment worth testing.
const bridge = vi.hoisted(() => ({ beforeInstalling: async (): Promise<void> => {} }))
vi.mock('./runtime/ipcBridge', async () => {
  await bridge.beforeInstalling()
  return {
    installIpcBridge: (): (() => void) => {
      throw new Error('the renderer bridge could not be installed')
    }
  }
})

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 30_000
const WORKTREE = 'wt_last_launch'
const TERMINAL = 'term_from_last_launch'

/** What the last launch left behind, ready for this one to bring back. */
type LastSession = {
  userDataDir: string
  /** Where the restored pane writes the pid of the process it is running. */
  pidFile: string
  /** The record the pane's own output is expected to land in. */
  scrollbackRecord: string
}

const temporaryDirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  // A test that failed has left a pane running, which is the whole subject
  // here: it is killed now rather than left to outlive the run.
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  bridge.beforeInstalling = async (): Promise<void> => {}
})

/**
 * A workspace file with one agent pane in it, and an agent for it to come back
 * as: a stand-in that reports the pid it is running under, says it is up, and
 * then sits there the way a real agent waiting for a turn does.
 */
async function lastSession(): Promise<LastSession> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-quit-startup-'))
  temporaryDirs.push(base)
  const checkout = join(base, 'checkout')
  const bin = join(base, 'bin')
  const userDataDir = join(base, 'userData')
  await mkdir(checkout, { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(userDataDir, { recursive: true })

  const pidFile = join(base, 'pane.pid')
  // Named for the agent it stands in for, because that name is how the restore
  // decides this pane has a conversation to resume rather than a command to
  // leave alone.
  const binary = join(bin, 'claude')
  await writeFile(binary, `#!/bin/sh\necho $$ > ${pidFile}\necho READY\nwhile true; do sleep 0.2; done\n`, 'utf8')
  await chmod(binary, 0o755)

  const store = await WorkspaceStore.open(join(userDataDir, WORKSPACE_FILE_NAME))
  store.putWorktree({
    id: WORKTREE,
    projectId: 'proj_1',
    name: 'last session',
    branch: 'teamree/last-session',
    path: checkout,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0
  })
  store.putTerminal({
    id: TERMINAL,
    worktreeId: WORKTREE,
    cwd: checkout,
    shell: testShell(),
    command: binary,
    agent: 'claude',
    agentSessionId: 'session_from_last_launch',
    cols: 80,
    rows: 24,
    createdAt: 0
  })
  await store.flush()

  return { userDataDir, pidFile, scrollbackRecord: join(userDataDir, SCROLLBACK_DIR_NAME, `${TERMINAL}.json`) }
}

/** The launch this app performs, as much of it as has no Electron in it. */
function launch(userDataDir: string, options: { serveRenderer: boolean }): Promise<Runtime> {
  return startRuntime({
    userDataDir,
    version: '0.0.0-test',
    // The CLI socket and the relay are their own suites' subject; what this one
    // is about is the panes, and every transport left on is one more reason for
    // a launch to take a different amount of time than the test expects.
    serveCli: false,
    serveTeamwork: false,
    checkForUpdates: false,
    ...options
  })
}

/** Whether a pid is still a process. The signal that asks and does nothing. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pidOfRestoredPane(pidFile: string): Promise<number> {
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  expect(Number.isInteger(pid), `${pidFile} should name the restored pane's process`).toBe(true)
  return pid
}

describePty('quitting before the app has finished starting', () => {
  it(
    'waits for the launch, then kills the panes that launch brought back',
    async () => {
      const session = await lastSession()
      let runtime: Runtime | undefined
      const quit = vi.fn()
      const preventDefault = vi.fn()

      // The launch as index.ts holds it: the runtime, and then the rest of the
      // work that has to happen before a window is up. Standing in for that
      // rest here is the wait for the restored pane to report itself, which is
      // what makes the pane these assertions are about one that certainly ran.
      const launched = (async () => {
        runtime = await launch(session.userDataDir, { serveRenderer: false })
        runtimes.push(runtime)
        await waitUntil(() => existsSync(session.pidFile), 'the restored pane to report its pid')
      })()

      // ⌘Q now — before the workspace file has even been opened, and a long way
      // before there is a handle to stop anything with.
      expect(runtime).toBeUndefined()
      createQuitSequence({ whenStarted: () => launched, stop: () => runtime?.stop() ?? Promise.resolve(), quit })({
        preventDefault
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(quit).not.toHaveBeenCalled()

      await waitUntil(() => quit.mock.calls.length === 1, 'the quit to be asked for once the teardown is done', 20_000)
      // The launch finishes either way — what is under test is whether the quit
      // waited for it — so awaiting it here means the pane read below is the
      // same pane whichever way the quit behaved.
      await launched

      const pid = await pidOfRestoredPane(session.pidFile)
      expect(alive(pid), 'the restored pane was left to die of a closed master fd').toBe(false)

      // And the last thing it printed is where the next launch will look for
      // it: the flush is the final step of the teardown, so a quit that did not
      // wait loses this even when it does kill the pane.
      const record = JSON.parse(await readFile(session.scrollbackRecord, 'utf8')) as { text: string }
      expect(record.text).toContain('READY')
    },
    TEST_TIMEOUT_MS
  )

  // The launch that never arrives at a runtime at all. Orphaned panes under a
  // window that never opened are a worse ending than the failure that caused
  // them, so the failing launch releases what it built on its way out — and the
  // quit still quits, which is the rule the failing teardown already follows.
  it(
    'kills them too when the launch fails outright, and quits anyway',
    async () => {
      const session = await lastSession()
      bridge.beforeInstalling = () =>
        waitUntil(() => existsSync(session.pidFile), 'the restored pane to report its pid')

      let runtime: Runtime | undefined
      const failures: unknown[] = []
      const quit = vi.fn()

      // index.ts survives a launch that failed — a window with no runtime
      // behind it is still a window that can say so — so the promise the quit
      // waits on is one that resolves either way.
      const launched = launch(session.userDataDir, { serveRenderer: true }).then(
        (started) => {
          runtime = started
          runtimes.push(started)
        },
        (error: unknown) => failures.push(error)
      )

      createQuitSequence({ whenStarted: () => launched, stop: () => runtime?.stop() ?? Promise.resolve(), quit })({
        preventDefault: vi.fn()
      })

      await waitUntil(() => quit.mock.calls.length === 1, 'the quit to be asked for', 20_000)
      await launched
      expect(failures).toHaveLength(1)
      expect(runtime).toBeUndefined()

      const pid = await pidOfRestoredPane(session.pidFile)
      expect(alive(pid), 'a launch that failed left its restored pane running').toBe(false)
      const record = JSON.parse(await readFile(session.scrollbackRecord, 'utf8')) as { text: string }
      expect(record.text).toContain('READY')
    },
    TEST_TIMEOUT_MS
  )
})
