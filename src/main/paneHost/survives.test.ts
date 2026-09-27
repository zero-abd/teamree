// The pane host as it runs for real: a detached process started by an app, which is then killed
// with SIGKILL. The pty lives on, and the next app attaches to the same pid and every byte, once.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build, type BuildOptions } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { canSpawnPty } from '../terminals/pty-test-support'
import { PaneHosting } from './hosting'
import { paneHostPaths } from './protocol'

const itPty = canSpawnPty() && process.platform !== 'win32' ? it : it.skip
const ROOT = resolve(import.meta.dirname, '../../..')

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Both ends as plain Node scripts; CommonJS so `node-pty` resolves through NODE_PATH from a temp dir. */
async function bundle(dir: string): Promise<{ host: string; app: string }> {
  const host = join(dir, 'paneHost.cjs')
  const app = join(dir, 'app.cjs')
  const common: BuildOptions = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node-pty'],
    logLevel: 'silent'
  }
  await build({ ...common, entryPoints: [join(ROOT, 'src/main/paneHost.ts')], outfile: host })
  await build({
    ...common,
    outfile: app,
    stdin: {
      resolveDir: join(ROOT, 'src/main/paneHost'),
      loader: 'ts',
      contents: `
        import { PaneHosting } from './hosting'
        process.on('uncaughtException', (error) => { console.error(error); process.exit(1) })
        const [userDataDir, entry] = process.argv.slice(2)
        void (async () => {
          const hosting = new PaneHosting({ userDataDir, appVersion: 'first', enabled: () => true, entry })
          await hosting.open()
          const pty = hosting.spawn('term_s', '/bin/sh', ['-c', 'i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.05; done'], {
            name: 'xterm-256color', cwd: userDataDir, cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' }
          })
          let text = ''
          pty.onData((data) => (text += data))
          const ready = setInterval(() => {
            if (pty.pid === 0 || !text.includes('tick 5\\r\\n')) return
            clearInterval(ready)
            process.stdout.write(JSON.stringify({ pid: pty.pid }) + '\\n')
          }, 20)
          setInterval(() => {}, 1000)
        })()
      `
    }
  })
  return { host, app }
}

itPty('keeps a pane through a SIGKILL of the app, and the next app attaches to the same pid', async () => {
  const base = await mkdtemp(join(tmpdir(), 'teamree-pane-host-survives-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const userDataDir = join(base, 'userData')
  await mkdir(userDataDir)
  const paths = paneHostPaths(userDataDir)
  cleanups.push(() => rm(dirname(paths.socket), { recursive: true, force: true }))
  const { host, app } = await bundle(base)

  const first = spawn(process.execPath, [app, userDataDir, host], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') }
  })
  cleanups.push(() => void (first.exitCode === null && first.kill('SIGKILL')))
  let said = ''
  first.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()))
  await until(() => said.includes('\n'), 'the first app to start a pane')
  const { pid } = JSON.parse(said) as { pid: number }
  const hostPid = Number(/listening, pid (\d+)/.exec(readFileSync(paths.log, 'utf8'))?.[1])
  cleanups.push(() => {
    for (const leftover of [pid, hostPid]) if (alive(leftover)) process.kill(leftover, 'SIGKILL')
  })
  expect(hostPid).toBeGreaterThan(0)
  expect(hostPid).not.toBe(first.pid)

  first.kill('SIGKILL')
  await new Promise((r) => first.once('exit', r))
  await new Promise((r) => setTimeout(r, 300))
  expect(alive(pid), 'the pane died with the app').toBe(true)
  expect(alive(hostPid), 'the host died with the app').toBe(true)

  let started = 0
  const second = new PaneHosting({
    userDataDir,
    appVersion: 'second',
    enabled: () => true,
    entry: host,
    startHost: () => void (started += 1)
  })
  await second.open()
  expect(started, 'a second host was started').toBe(0)
  const session = second.live().find((live) => live.terminal === 'term_s')
  expect(session?.pid).toBe(pid)

  const pty = second.attach(session as NonNullable<typeof session>)
  let text = ''
  pty.onData((data) => (text += data))
  const ticks = (): number[] => [...text.matchAll(/tick (\d+)\r\n/g)].map((match) => Number(match[1]))
  await until(() => ticks().length > 0, 'the replay')
  const replayed = ticks().length
  await until(() => ticks().length > replayed + 5, 'live output after the replay')
  // The replay, with what was printed while no app was attached, then live: each tick once, in order.
  expect(ticks()).toEqual(ticks().map((_, index) => index + 1))

  await second.release(false)
  await until(() => !alive(pid) && !alive(hostPid), 'the host and its pane to stop')
  expect(existsSync(paths.socket)).toBe(false)
})
