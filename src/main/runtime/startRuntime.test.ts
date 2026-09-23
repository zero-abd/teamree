// What a stopped runtime leaves behind: nothing that says it is running. A stale
// discovery file is a CLI trying a socket nobody answers, so the file has to go
// whatever else the teardown managed.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoveryFilePath } from './discoveryFile'
import { startRuntime, type Runtime } from './startRuntime'

// The bridge is the first thing `stop` takes down; this one refuses when the test says so.
const bridge = vi.hoisted(() => ({ uninstallThrows: false }))
vi.mock('./ipcBridge', () => ({
  installIpcBridge: (): (() => void) => () => {
    if (bridge.uninstallThrows) throw new Error('the bridge would not come down')
  }
}))

const dirs: string[] = []
const runtimes: Runtime[] = []

afterEach(async () => {
  bridge.uninstallThrows = false
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop().catch(() => {})))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function running(onError: (error: unknown) => void): Promise<{ runtime: Runtime; discovery: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'teamree-runtime-'))
  dirs.push(userDataDir)
  const runtime = await startRuntime({
    userDataDir,
    version: '0.0.0-test',
    serveCli: true,
    serveRenderer: true,
    serveTeamwork: false,
    checkForUpdates: false,
    onError
  })
  runtimes.push(runtime)
  return { runtime, discovery: discoveryFilePath(userDataDir) }
}

describe('stopping the runtime', () => {
  it('removes the discovery file and releases the socket', async () => {
    const onError = vi.fn()
    const { runtime, discovery } = await running(onError)
    expect(existsSync(discovery)).toBe(true)
    expect(existsSync(runtime.endpoint)).toBe(true)

    await runtime.stop()

    expect(existsSync(discovery)).toBe(false)
    expect(existsSync(runtime.endpoint)).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('still removes them when an earlier step of the teardown throws', async () => {
    const onError = vi.fn()
    const { runtime, discovery } = await running(onError)
    bridge.uninstallThrows = true

    await runtime.stop()

    expect(existsSync(discovery)).toBe(false)
    expect(existsSync(runtime.endpoint)).toBe(false)
    // Reported, not swallowed: a teardown that failed is worth a line.
    expect(onError).toHaveBeenCalledOnce()
    expect(String(onError.mock.calls[0]?.[0])).toContain('the bridge would not come down')
  })
})
