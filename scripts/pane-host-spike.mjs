#!/usr/bin/env node
// Spike for docs/plans/pane-host.md: a detached host owns a pty, the "app" that started it is
// killed with SIGKILL, and a second app reattaches over the host's unix socket to the same pid,
// replaying the scrollback and streaming live output. Not used by the app.
//
//   node scripts/pane-host-spike.mjs --dir <empty scratch folder>
//
// Prints PASS and exits 0, or FAIL with the reason and exits 1. Everything it writes is in --dir.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const MOST_REPLAY = 64 * 1024

/** Newline-delimited JSON, both ways. */
function lines(socket, onMessage) {
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    pending += chunk
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (line !== '') onMessage(JSON.parse(line))
    }
  })
}
const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`)

/** The host: owns one pty, keeps its tail, and serves any client that knows the token. */
async function host(dir) {
  const { spawn: spawnPty } = await import('node-pty')
  const token = readFileSync(join(dir, 'token'), 'utf8')
  const pty = spawnPty('/bin/sh', ['-c', 'i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.1; done'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: dir,
    env: { PATH: '/usr/bin:/bin' }
  })
  let replay = ''
  const clients = new Set()
  pty.onData((data) => {
    replay = (replay + data).slice(-MOST_REPLAY)
    for (const client of clients) send(client, { type: 'data', data })
  })
  // Relative, from the folder: a scratch path can be longer than sun_path's 104 bytes.
  process.chdir(dir)
  const socketPath = 'host.sock'
  const server = createServer((socket) => {
    lines(socket, (message) => {
      if (!clients.has(socket)) {
        if (message.type !== 'attach' || message.token !== token) return socket.destroy()
        clients.add(socket)
        send(socket, { type: 'hello', hostPid: process.pid, ptyPid: pty.pid, replay })
        return
      }
      if (message.type === 'kill') {
        pty.kill()
        server.close()
        rmSync(socketPath, { force: true })
        process.exit(0)
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })
  pty.onExit(() => {
    rmSync(socketPath, { force: true })
    process.exit(0)
  })
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600)
    writeFileSync('host.pid', String(process.pid))
  })
}

/** Connects and attaches; resolves once the hello arrives, with every later chunk collected. */
function attach(dir) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: 'host.sock' })
    const live = []
    socket.on('error', reject)
    socket.on('connect', () => send(socket, { type: 'attach', token: readFileSync(join(dir, 'token'), 'utf8') }))
    lines(socket, (message) => {
      if (message.type === 'hello') resolvePromise({ socket, hello: message, live })
      else if (message.type === 'data') live.push(message.data)
    })
  })
}

async function until(check, what, ms = 5_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The first app: starts the host detached, attaches, says what it sees, then waits to be killed. */
async function app(dir) {
  const child = spawn(process.execPath, [SCRIPT, 'host', dir], { detached: true, stdio: 'ignore' })
  child.unref()
  await until(() => existsSync(join(dir, 'host.pid')), 'the host to listen')
  const { hello, live } = await attach(dir)
  await until(() => live.join('').includes('tick 5'), 'live output')
  process.stdout.write(`${JSON.stringify({ ptyPid: hello.ptyPid, hostPid: hello.hostPid })}\n`)
  setInterval(() => {}, 1_000)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const lastTick = (text) => Math.max(0, ...[...text.matchAll(/tick (\d+)/g)].map((match) => Number(match[1])))

async function prove(dir) {
  const first = spawn(process.execPath, [SCRIPT, 'app', dir], { stdio: ['ignore', 'pipe', 'inherit'] })
  let said = ''
  first.stdout.on('data', (chunk) => (said += chunk))
  await until(() => said.includes('\n'), 'the first app to attach')
  const before = JSON.parse(said)

  first.kill('SIGKILL')
  await new Promise((r) => first.once('exit', r))
  await new Promise((r) => setTimeout(r, 500))
  if (!alive(before.hostPid) || !alive(before.ptyPid)) throw new Error('the host or its pty died with the app')

  const { socket, hello, live } = await attach(dir)
  if (hello.ptyPid !== before.ptyPid) throw new Error(`reattached to pty ${hello.ptyPid}, not ${before.ptyPid}`)
  const replayed = lastTick(hello.replay)
  if (replayed < 5) throw new Error('the replay lacks what the first app saw')
  await until(() => lastTick(live.join('')) > replayed + 3, 'live output after reattaching')

  send(socket, { type: 'kill' })
  await until(() => !alive(before.ptyPid) && !alive(before.hostPid), 'the host to stop')
  return { pid: before.ptyPid, replayed, live: lastTick(live.join('')) }
}

const [mode, dirArgument] = process.argv.slice(2)
if (mode === 'host') await host(dirArgument)
else if (mode === 'app') {
  process.chdir(dirArgument)
  await app(dirArgument)
} else {
  const flag = process.argv.indexOf('--dir')
  const raw = flag === -1 ? '' : (process.argv[flag + 1] ?? '')
  const dir = raw === '' ? '' : resolve(raw)
  // An empty lookup once wrote fixtures into a home folder.
  if (dir === '' || dir === homedir() || dir === '/') {
    console.error('usage: node scripts/pane-host-spike.mjs --dir <empty scratch folder>')
    process.exit(2)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  writeFileSync(join(dir, 'token'), randomBytes(32).toString('hex'), { mode: 0o600 })
  process.chdir(dir)
  let code = 0
  try {
    const result = await prove(dir)
    console.log(`PASS pty ${result.pid} outlived its app; replay to tick ${result.replayed}, live to ${result.live}`)
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    const pid = existsSync('host.pid') ? Number(readFileSync('host.pid', 'utf8')) : 0
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGTERM')
    code = 1
  }
  for (const name of ['token', 'host.pid', 'host.sock']) rmSync(join(dir, name), { force: true })
  process.exit(code)
}
