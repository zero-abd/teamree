// The pane host and `RemotePty` in this process, over a real socket in a temp dir, with real ptys.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import { canSpawnPty } from '../terminals/pty-test-support'
import { TerminalSessionManager, type ScrollbackRepository } from '../terminals/session-manager'
import type { TerminalRecord } from '../terminals/session-restore'
import type { RecordedScrollback } from '../terminals/scrollbackRecord'
import { PaneHostClient, type RemotePty } from './client'
import { startPaneHost, type PaneHost } from './host'
import { PaneHosting } from './hosting'
import { ensurePrivateDir, paneHostPaths, type PaneHostPaths } from './protocol'

const describePty = canSpawnPty() && process.platform !== 'win32' ? describe : describe.skip

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scratch(): Promise<{ base: string; paths: PaneHostPaths }> {
  const base = await mkdtemp(join(tmpdir(), 'teamree-pane-host-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const paths = paneHostPaths(join(base, 'userData'))
  ensurePrivateDir(paths.dir)
  // A temp dir is too long for sun_path, so the socket lands in a folder of its own.
  ensurePrivateDir(dirname(paths.socket))
  cleanups.push(() => rm(dirname(paths.socket), { recursive: true, force: true }))
  return { base, paths }
}

async function host(paths: PaneHostPaths, extra: Partial<Parameters<typeof startPaneHost>[0]> = {}): Promise<PaneHost> {
  const started = await startPaneHost({ socket: paths.socket, token: paths.token, hostVersion: 'test', ...extra })
  cleanups.push(() => started.close())
  return started
}

async function connect(paths: PaneHostPaths): Promise<PaneHostClient> {
  const result = await PaneHostClient.connect({ socket: paths.socket, tokenPath: paths.token, appVersion: 'test' })
  if (!('client' in result)) throw new Error(`no client: ${JSON.stringify(result)}`)
  cleanups.push(() => result.client.detach())
  return result.client
}

function collect(pty: RemotePty): { text: () => string } {
  let text = ''
  pty.onData((data) => (text += data))
  return { text: () => text }
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const shellOptions = (cwd: string) => ({
  name: 'xterm-256color',
  cwd,
  cols: 80,
  rows: 24,
  env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
})

describePty('RemotePty over the pane host', () => {
  it('keeps its socket and token to this user', async () => {
    const { paths } = await scratch()
    await host(paths)
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700)
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600)
    expect(statSync(paths.token).mode & 0o777).toBe(0o600)
  })

  it('spawns, writes, resizes and reports the exit status', async () => {
    const { base, paths } = await scratch()
    await host(paths)
    const client = await connect(paths)
    const pty = client.spawn('term_a', '/bin/sh', [], shellOptions(base))
    const out = collect(pty)
    let exit: { exitCode: number; signal?: number } | undefined
    pty.onExit((event) => (exit = event))

    await until(() => pty.pid > 0, 'the pid')
    pty.resize(100, 30)
    pty.write('stty size; echo said-$((6*7)); exit 3\n')
    await until(() => exit !== undefined, 'the exit')
    expect(out.text()).toContain('30 100')
    expect(out.text()).toContain('said-42')
    expect(exit?.exitCode).toBe(3)
  })

  it('kills a pty on request', async () => {
    const { base, paths } = await scratch()
    await host(paths)
    const client = await connect(paths)
    const pty = client.spawn('term_k', '/bin/sh', ['-c', 'echo up; exec sleep 30'], shellOptions(base))
    const out = collect(pty)
    let exit: { exitCode: number; signal?: number } | undefined
    pty.onExit((event) => (exit = event))
    await until(() => out.text().includes('up'), 'the pty to start')
    const pid = pty.pid
    pty.kill('SIGTERM')
    await until(() => exit !== undefined, 'the exit')
    expect(exit?.signal).toBe(15)
    expect(alive(pid)).toBe(false)
  })

  it('refuses a hello without the token', async () => {
    const { paths } = await scratch()
    await host(paths)
    await writeFile(paths.token + '.wrong', 'f'.repeat(64))
    const result = await PaneHostClient.connect({
      socket: paths.socket,
      tokenPath: paths.token + '.wrong',
      appVersion: 'test'
    })
    expect(result).toEqual({ refused: 'the host closed the connection' })
  })

  it('hands the panes to a second app, replaying before live output, with no byte twice', async () => {
    const { base, paths } = await scratch()
    await host(paths)
    const first = await connect(paths)
    const pty = first.spawn(
      'term_t',
      '/bin/sh',
      ['-c', 'i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.02; done'],
      shellOptions(base)
    )
    const firstOut = collect(pty)
    await until(() => firstOut.text().includes('tick 10\r\n'), 'ticks')
    const pid = pty.pid

    const second = await connect(paths)
    await until(() => !first.connected, 'the first app to be let go')
    const [session] = second.sessions
    expect(session).toMatchObject({ terminal: 'term_t', pid })
    const attached = second.attach(session as NonNullable<typeof session>)
    const secondOut = collect(attached)
    await until(() => ticks(secondOut.text()).length > 30, 'live ticks after the replay')

    const seen = ticks(secondOut.text())
    // Every tick once, in order, from the first: the replay and the live data meet without a gap or a repeat.
    expect(seen).toEqual(seen.map((_, index) => index + 1))
    expect(alive(pid)).toBe(true)
  })

  it('attaches from a byte offset', async () => {
    const { base, paths } = await scratch()
    await host(paths)
    const first = await connect(paths)
    const pty = first.spawn('term_o', '/bin/sh', ['-c', 'echo one; echo two; exec sleep 30'], shellOptions(base))
    const out = collect(pty)
    await until(() => out.text().includes('two'), 'output')
    const { offset } = pty.hostMark

    const second = await connect(paths)
    const session = second.sessions[0]
    if (session === undefined) throw new Error('no session')
    const tail = collect(second.attach(session, offset))
    const whole = collect(second.attach(session))
    await until(() => whole.text().includes('two'), 'the replay')
    expect(tail.text()).not.toContain('one')
    pty.kill()
  })

  it('refuses a host newer than this app and leaves it running', async () => {
    const { paths } = await scratch()
    await host(paths, { protocol: 99 })
    const result = await PaneHostClient.connect({ socket: paths.socket, tokenPath: paths.token, appVersion: 'test' })
    expect(result).toEqual({ refused: 'the host speaks protocol 99, newer than this app' })
  })

  it('exits once idle with no app and no pane', async () => {
    const { paths } = await scratch()
    let closed = false
    await host(paths, { idleMs: 50, onClosed: () => (closed = true) })
    const client = await connect(paths)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(closed).toBe(false)
    await client.detach()
    await until(() => closed, 'the idle exit')
    expect(() => statSync(paths.socket)).toThrow()
  })
})

describePty('restoreSessions with the pane host', () => {
  it('attaches a kept pane to the same pid instead of starting it again', async () => {
    const { base, paths } = await scratch()
    const checkout = join(base, 'checkout')
    await mkdir(checkout)
    const userDataDir = join(base, 'userData')
    const hosting = (): PaneHosting =>
      new PaneHosting({
        userDataDir,
        appVersion: 'test',
        enabled: () => true,
        entry: 'in-process',
        startHost: () => void host(paths)
      })
    const records = new Map<string, TerminalRecord>()
    const archive = new Map<string, RecordedScrollback>()
    const sessions = {
      listTerminals: () => [...records.values()],
      putTerminal: (record: TerminalRecord) => (records.set(record.id, record), record),
      removeTerminal: (id: string) => records.delete(id)
    }
    const scrollback: ScrollbackRepository = {
      read: (id) => archive.get(id),
      put: (id, text, hosted) => void archive.set(id, { text, recordedAt: 1, ...(hosted ? { host: hosted } : {}) }),
      remove: (id) => void archive.delete(id),
      flush: async () => {}
    }
    const layouts = new Map<string, Layout>()
    const options = {
      resolveWorktreeCwd: () => checkout,
      sessions,
      scrollback,
      layouts: {
        getLayout: (id: string) => layouts.get(id),
        putLayout: (layout: Layout) => (layouts.set(layout.worktreeId, layout), layout),
        listLayouts: () => [...layouts.values()]
      }
    }

    const firstHost = hosting()
    await firstHost.open()
    const first = new TerminalSessionManager({ ...options, paneHost: firstHost })
    const terminal = first.create({
      worktreeId: 'wt',
      shell: '/bin/sh',
      command: 'i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.02; done'
    })
    await until(() => first.read(terminal.id).includes('tick 5\r\n'), 'ticks')
    const pid = first.paneProcesses()[0]?.pid
    expect(pid).toBeGreaterThan(0)
    // A quit that keeps the panes: the record is written and the socket let go.
    await first.shutdown()
    expect(alive(pid as number)).toBe(true)
    expect(archive.get(terminal.id)?.host?.session).toMatch(/^term_/)

    const secondHost = hosting()
    await secondHost.open()
    const second = new TerminalSessionManager({ ...options, paneHost: secondHost })
    expect(second.restoreSessions()).toEqual({ restored: 1, resumed: 0 })
    expect(second.paneProcesses()).toEqual([{ terminalId: terminal.id, worktreeId: 'wt', pid }])
    const before = ticks(second.read(terminal.id)).length
    await until(() => ticks(second.read(terminal.id)).length > before + 10, 'live ticks')
    const seen = ticks(second.read(terminal.id))
    expect(seen).toEqual(seen.map((_, index) => index + 1))

    // Closing the pane in the app ends it in the host.
    await second.close(terminal.id)
    await until(() => !alive(pid as number), 'the pane to end')
    await secondHost.release(false)
  })
})

function ticks(text: string): number[] {
  return [...text.matchAll(/tick (\d+)\r\n/g)].map((match) => Number(match[1]))
}
