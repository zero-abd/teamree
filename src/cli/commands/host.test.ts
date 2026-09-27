// `teamree host` once the app has gone: it reads and stops the pane host itself.

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneHosting } from '../../main/paneHost/hosting.js'
import { paneHostPaths } from '../../main/paneHost/protocol.js'
import { canSpawnPty } from '../../main/terminals/pty-test-support.js'
import type { Streams } from '../output.js'
import { runCli } from '../run.js'

const ROOT = resolve(import.meta.dirname, '../../..')
const describePty = canSpawnPty() && process.platform !== 'win32' ? describe : describe.skip

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function profile(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-host-cli-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  return join(base, 'userData')
}

async function cli(userDataDir: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const streams: Streams = { out: (text) => (out += text), err: (text) => (err += text) }
  const code = await runCli(argv, { streams, env: { TEAMREE_USER_DATA_DIR: userDataDir }, cwd: tmpdir() })
  return { code, out, err }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('teamree host, with no app and no host', () => {
  it('says the host is not running, and that there was nothing to stop', async () => {
    const userDataDir = await profile()
    const seen = await cli(userDataDir, ['host', 'status', '--json'])
    expect(seen.code, seen.err).toBe(0)
    expect(JSON.parse(seen.out).data).toEqual({ running: false, panes: 0, inProcess: 0, shells: 0 })
    const stopped = await cli(userDataDir, ['host', 'stop'])
    expect(stopped.code, stopped.err).toBe(0)
    expect(stopped.out).toContain('no pane host running')
    expect(existsSync(join(userDataDir, 'pane-host'))).toBe(false)
  })
})

describePty('teamree host, with a host the app left running', () => {
  it('shows the host and its panes, and stops them', async () => {
    const userDataDir = await profile()
    const entry = join(dirname(userDataDir), 'paneHost.cjs')
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
    const paths = paneHostPaths(userDataDir)
    cleanups.push(() => rm(dirname(paths.socket), { recursive: true, force: true }))
    const hostPid = (): number => Number(/listening, pid (\d+)/.exec(readFileSync(paths.log, 'utf8'))?.[1] ?? 0)
    cleanups.push(() => {
      if (existsSync(paths.log) && alive(hostPid())) process.kill(hostPid(), 'SIGKILL')
    })

    const hosting = new PaneHosting({ userDataDir, appVersion: 'test', enabled: () => true, entry })
    await hosting.open()
    const pty = hosting.spawn('term_1', '/bin/sh', [], {
      name: 'xterm-256color',
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: { PATH: '/usr/bin:/bin' }
    })
    const deadline = Date.now() + 10_000
    while (pty.pid === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    const pane = pty.pid
    expect(pane).toBeGreaterThan(0)
    await hosting.release(true)

    const seen = await cli(userDataDir, ['host', 'status'])
    expect(seen.code, seen.err).toBe(0)
    expect(seen.out).toContain(`running, pid ${hostPid()}`)
    expect(seen.out).toMatch(/panes:\s+1/)

    const stopped = await cli(userDataDir, ['host', 'stop'])
    expect(stopped.code, stopped.err).toBe(0)
    expect(stopped.out).toBe(`stopped pid ${hostPid()}, ended 1 pane\n`)
    expect(alive(hostPid())).toBe(false)
    const gone = Date.now() + 5_000
    while (alive(pane) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20))
    expect(alive(pane)).toBe(false)
  })
})
