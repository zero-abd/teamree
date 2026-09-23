// ⌘Q pressed in the second before the app has finished starting: `startRuntime`
// restores panes before it hands back the handle whose `stop` can kill them.
// Real workspace file, real pty, real archive; asserted is what the user finds after.

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

// The renderer bridge is the last step of a launch and the one that can throw
// (`ipcMain.handle` refuses a taken channel); the gate lands the failure after
// the restored pane is up.
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
  // A test that failed has left a pane running.
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  bridge.beforeInstalling = async (): Promise<void> => {}
})

/** A workspace file with one agent pane, and a stand-in agent that reports its pid and sits there. */
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
  // Named for the agent: that is how the restore decides this pane resumes.
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
    // Every transport left on is one more reason for a launch to take a different time.
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

      // The launch as index.ts holds it; the wait for the pane to report itself
      // stands in for the rest of the work before a window is up.
      const launched = (async () => {
        runtime = await launch(session.userDataDir, { serveRenderer: false })
        runtimes.push(runtime)
        await waitUntil(() => existsSync(session.pidFile), 'the restored pane to report its pid')
      })()

      // ⌘Q now, before there is a handle to stop anything with.
      expect(runtime).toBeUndefined()
      createQuitSequence({ whenStarted: () => launched, stop: () => runtime?.stop() ?? Promise.resolve(), quit })({
        preventDefault
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(quit).not.toHaveBeenCalled()

      await waitUntil(() => quit.mock.calls.length === 1, 'the quit to be asked for once the teardown is done', 20_000)
      // The launch finishes either way; awaiting it makes the pane below the same whichever way the quit went.
      await launched

      const pid = await pidOfRestoredPane(session.pidFile)
      expect(alive(pid), 'the restored pane was left to die of a closed master fd').toBe(false)

      // The flush is the final step of the teardown: a quit that did not wait loses this.
      const record = JSON.parse(await readFile(session.scrollbackRecord, 'utf8')) as { text: string }
      expect(record.text).toContain('READY')
    },
    TEST_TIMEOUT_MS
  )

  // A failing launch releases what it built on its way out, and the quit still quits.
  it(
    'kills them too when the launch fails outright, and quits anyway',
    async () => {
      const session = await lastSession()
      bridge.beforeInstalling = () =>
        waitUntil(() => existsSync(session.pidFile), 'the restored pane to report its pid')

      let runtime: Runtime | undefined
      const failures: unknown[] = []
      const quit = vi.fn()

      // index.ts survives a failed launch, so the promise the quit waits on resolves either way.
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
