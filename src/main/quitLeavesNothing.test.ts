// A quit ends every process the app started, even the ones that ignore the
// hangup a closing terminal sends. Real runtime, real socket, real pty.

import { existsSync, watch } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Terminal } from '../shared/entities'
import type { Response } from '../shared/protocol'
import { createQuitSequence } from './quitSequence'
import { discoveryFilePath } from './runtime/discoveryFile'
import { startRuntime, WORKSPACE_FILE_NAME, type Runtime } from './runtime/startRuntime'
import { SCROLLBACK_DIR_NAME } from './store/scrollbackArchive'
import { WorkspaceStore } from './store/workspaceStore'
import { canSpawnPty } from './terminals/pty-test-support'

const itPty = canSpawnPty() && process.platform !== 'win32' ? it : it.skip
const TEST_TIMEOUT_MS = 30_000
const WORKTREE = 'wt_quitting'

const temporaryDirs: string[] = []
const runtimes: Runtime[] = []
/** Every pid a test saw, killed after it whatever the outcome: a failure here is a process left running. */
const seen: number[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  for (const pid of seen.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Resolves once `file` exists. No deadline of its own: under load, only the test's timeout is fair. */
function whenPresent(file: string): Promise<void> {
  return new Promise((resolve) => {
    const settle = (): void => {
      if (!existsSync(file)) return
      watcher.close()
      resolve()
    }
    const watcher = watch(dirname(file), settle)
    settle()
  })
}

async function pidIn(file: string): Promise<number> {
  await whenPresent(file)
  return Number((await readFile(file, 'utf8')).trim())
}

itPty(
  'leaves no process behind, and the workspace, scrollback and endpoint as they should be',
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'teamree-quit-nothing-'))
    temporaryDirs.push(base)
    const checkout = join(base, 'checkout')
    const userDataDir = join(base, 'userData')
    await mkdir(checkout, { recursive: true })
    await mkdir(userDataDir, { recursive: true })

    // A program that leaves on the hangup, and a child of its own that ignores it.
    const paneFile = join(base, 'pane.pid')
    const childFile = join(base, 'child.pid')
    const program = join(base, 'stubborn')
    await writeFile(
      program,
      '#!/bin/sh\n' +
        `sh -c 'trap "" HUP; echo $$ > ${childFile}.part && mv ${childFile}.part ${childFile}; while true; do sleep 0.2; done' &\n` +
        `echo $$ > ${paneFile}.part && mv ${paneFile}.part ${paneFile}\n` +
        'echo READY\n' +
        'while true; do sleep 0.2; done\n',
      'utf8'
    )
    await chmod(program, 0o755)

    const seed = await WorkspaceStore.open(join(userDataDir, WORKSPACE_FILE_NAME))
    seed.putWorktree({
      id: WORKTREE,
      projectId: 'proj_1',
      name: 'quitting',
      branch: 'teamree/quitting',
      path: checkout,
      startedFrom: 'main',
      state: 'ready',
      createdAt: 0
    })
    await seed.flush()

    const runtime = await startRuntime({
      userDataDir,
      version: '0.0.0-test',
      serveRenderer: false,
      serveTeamwork: false,
      checkForUpdates: false
    })
    runtimes.push(runtime)
    const endpoint = runtime.endpoint

    const response = (await runtime.dispatch(
      { id: 'r1', method: 'terminal.create', params: { worktreeId: WORKTREE, command: program } },
      { connectionId: 'test' }
    )) as Response
    if (!response.ok) throw new Error(`terminal.create failed: ${response.error.message}`)
    const terminal = response.result as Terminal
    const pane = await pidIn(paneFile)
    const child = await pidIn(childFile)
    seen.push(pane, child)
    expect(alive(pane) && alive(child)).toBe(true)

    let asked!: () => void
    const quitAsked = new Promise<void>((resolve) => (asked = resolve))
    createQuitSequence({ stop: () => runtime.stop(), quit: asked })({ preventDefault: vi.fn() })
    await quitAsked

    expect(alive(pane), 'the pane’s program outlived the quit').toBe(false)
    expect(alive(child), 'a child of the pane outlived the quit').toBe(false)
    expect(existsSync(endpoint)).toBe(false)
    expect(existsSync(discoveryFilePath(userDataDir))).toBe(false)

    const workspace = JSON.parse(await readFile(join(userDataDir, WORKSPACE_FILE_NAME), 'utf8')) as {
      terminals: Array<{ id: string }>
    }
    expect(workspace.terminals.map((record) => record.id)).toContain(terminal.id)
    const scrollback = JSON.parse(
      await readFile(join(userDataDir, SCROLLBACK_DIR_NAME, `${terminal.id}.json`), 'utf8')
    ) as { text: string }
    expect(scrollback.text).toContain('READY')
  },
  TEST_TIMEOUT_MS
)
