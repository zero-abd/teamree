// Keep Agents Running When teamree Quits, through the real runtime. Off, a launch and a quit are
// what they were before the pane host existed: no host process, no socket, node-pty in this process.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Response } from '../../shared/protocol'
import { createQuitSequence } from '../quitSequence'
import { startRuntime, WORKSPACE_FILE_NAME, type Runtime } from '../runtime/startRuntime'
import { WorkspaceStore } from '../store/workspaceStore'
import { canSpawnPty } from '../terminals/pty-test-support'
import { paneHostPaths } from './protocol'

const spies = vi.hoisted(() => ({ childSpawn: vi.fn(), ptySpawn: vi.fn(), connect: vi.fn() }))

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    spies.childSpawn(...args)
    return actual.spawn(...args)
  }
  return { ...actual, default: { ...actual, spawn }, spawn }
})
vi.mock('node-pty', async (original) => {
  const actual = await original<typeof import('node-pty')>()
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    spies.ptySpawn(...args)
    return actual.spawn(...args)
  }
  return { ...actual, default: { ...actual, spawn }, spawn }
})
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>()
  const createConnection = ((...args: unknown[]) => {
    spies.connect(...args)
    return (actual.createConnection as (...rest: unknown[]) => unknown)(...args)
  }) as typeof actual.createConnection
  return { ...actual, default: { ...actual, createConnection }, createConnection }
})

const describePty = canSpawnPty() && process.platform !== 'win32' ? describe : describe.skip
const ROOT = resolve(import.meta.dirname, '../../..')
const WORKTREE = 'wt_keep'
const TERMINAL = 'term_kept'

const cleanups: (() => Promise<void> | void)[] = []
const runtimes: Runtime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.clearAllMocks()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A profile with one worktree and one shell pane recorded, as the last run left it. */
async function profile(keepPanesRunning: boolean | undefined): Promise<{ userDataDir: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-keep-panes-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const checkout = join(base, 'checkout')
  const userDataDir = join(base, 'userData')
  await mkdir(checkout, { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  const seed = await WorkspaceStore.open(join(userDataDir, WORKSPACE_FILE_NAME))
  seed.putWorktree({
    id: WORKTREE,
    projectId: 'proj_1',
    name: 'keep',
    branch: 'teamree/keep',
    path: checkout,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0
  })
  seed.putTerminal({
    id: TERMINAL,
    worktreeId: WORKTREE,
    cwd: checkout,
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    createdAt: 1
  })
  seed.putLayout({ worktreeId: WORKTREE, root: { kind: 'leaf', terminalId: TERMINAL }, focusedTerminalId: TERMINAL })
  if (keepPanesRunning !== undefined) seed.setRuntimeSettings({ keepPanesRunning })
  await seed.flush()
  return { userDataDir, base }
}

async function launch(userDataDir: string, paneHostEntry: string): Promise<Runtime> {
  const runtime = await startRuntime({
    userDataDir,
    version: '0.0.0-test',
    serveCli: false,
    serveRenderer: false,
    serveTeamwork: false,
    checkForUpdates: false,
    paneHostEntry
  })
  runtimes.push(runtime)
  return runtime
}

async function quit(runtime: Runtime): Promise<void> {
  runtimes.splice(runtimes.indexOf(runtime), 1)
  let asked!: () => void
  const quitAsked = new Promise<void>((resolve) => (asked = resolve))
  createQuitSequence({ stop: () => runtime.stop(), quit: asked })({ preventDefault: vi.fn() })
  await quitAsked
}

const touchesHost = (entry: string, userDataDir: string) => ({
  started: spies.childSpawn.mock.calls.some((call) => JSON.stringify(call).includes(entry)),
  connected: spies.connect.mock.calls.some((call) =>
    JSON.stringify(call).includes(dirname(paneHostPaths(userDataDir).socket))
  ),
  files: existsSync(join(userDataDir, 'pane-host')) || existsSync(dirname(paneHostPaths(userDataDir).socket))
})

describePty('Keep Agents Running When teamree Quits', () => {
  for (const setting of [undefined, false]) {
    it(`${setting === undefined ? 'never set' : 'off'}: no host, panes in process, and a quit kills them`, async () => {
      const { userDataDir, base } = await profile(setting)
      const entry = join(base, 'paneHost.js')
      const runtime = await launch(userDataDir, entry)

      const pane = runtime.terminals().find((terminal) => terminal.id === TERMINAL)
      expect(pane?.running).toBe(true)
      expect(spies.ptySpawn).toHaveBeenCalled()
      const pid = await panePid(runtime)
      expect(pid).toBeGreaterThan(0)
      expect(runtime.panesKeptOnQuit()).toEqual([])

      await quit(runtime)
      expect(alive(pid), 'the pane outlived the quit').toBe(false)
      expect(touchesHost(entry, userDataDir)).toEqual({ started: false, connected: false, files: false })
    })
  }

  it('on: the pane runs in the host, and survives the quit', async () => {
    const { userDataDir, base } = await profile(true)
    const entry = join(base, 'paneHost.cjs')
    await build({
      entryPoints: [join(ROOT, 'src/main/paneHost.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node-pty'],
      logLevel: 'silent'
    })
    vi.stubEnv('NODE_PATH', join(ROOT, 'node_modules'))
    cleanups.push(() => void vi.unstubAllEnvs())
    cleanups.push(() => rm(dirname(paneHostPaths(userDataDir).socket), { recursive: true, force: true }))
    // A failure part way must not leave the host behind; its ptys hang up with it.
    cleanups.push(() => {
      const log = paneHostPaths(userDataDir).log
      const hostPid = existsSync(log) ? Number(/listening, pid (\d+)/.exec(readFileSync(log, 'utf8'))?.[1]) : 0
      if (hostPid > 0 && alive(hostPid)) process.kill(hostPid, 'SIGKILL')
    })

    const runtime = await launch(userDataDir, entry)
    expect(runtime.panesKeptOnQuit()).toEqual([TERMINAL])
    expect(touchesHost(entry, userDataDir)).toEqual({ started: true, connected: true, files: true })
    expect(spies.ptySpawn).not.toHaveBeenCalled()
    const pid = await panePid(runtime)
    expect(pid).toBeGreaterThan(0)

    await quit(runtime)
    expect(alive(pid), 'the pane died with the quit').toBe(true)

    const again = await launch(userDataDir, entry)
    expect(await panePid(again)).toBe(pid)
    // Turned off, the next quit ends the pane and the host.
    again.context.store.setRuntimeSettings({ keepPanesRunning: false })
    await quit(again)
    const gone = Date.now() + 5_000
    while (alive(pid) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20))
    expect(alive(pid)).toBe(false)
  })
})

/** Asks the pane's shell for its pid, through the same methods the window uses. */
async function panePid(runtime: Runtime): Promise<number> {
  const call = async (method: string, params: object): Promise<unknown> => {
    const response = (await runtime.dispatch({ id: method, method, params }, { connectionId: 'test' })) as Response
    if (!response.ok) throw new Error(`${method}: ${response.error.message}`)
    return response.result
  }
  const marker = `pid-${Math.random().toString(36).slice(2, 8)}`
  await call('terminal.write', { terminalId: TERMINAL, data: `echo ${marker}-$$\n` })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const { data } = (await call('terminal.read', { terminalId: TERMINAL })) as { data: string }
    const found = new RegExp(`${marker}-(\\d+)`).exec(data)
    if (found) return Number(found[1])
    await new Promise((r) => setTimeout(r, 25))
  }
  return 0
}
