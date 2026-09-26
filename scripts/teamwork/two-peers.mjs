#!/usr/bin/env node
// Two teamree peers on one machine: two runtimes, two user data dirs, two clones,
// a real relay between them, all torn down afterwards.
//   node scripts/teamwork/two-peers.mjs [--keep]

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createExampleRepo } from '../../examples/init-example-repo.mjs'
import { childEnv } from '../child-env.mjs'
import { readRoster } from './identity.mjs'
import { connectToRuntime } from './peer-client.mjs'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RUNTIME_HOST = join(REPO_ROOT, 'scripts', 'acceptance-host.mjs')
const DISCOVERY_FILE = 'runtime.json'

/**
 * What every clone calls `origin`. The project key is a hash of the normalised
 * origin URL, which needs a host: a bare path or `file://localhost/…` (host folded
 * away by the URL standard) has both runtimes refuse to compare origins at all.
 * Nothing dials this; `gitPush`/`gitPull` name `TRANSPORT_REMOTE`.
 */
const PROJECT_REMOTE = 'git@teamree.invalid:teamree/ledger.git'

/** The remote that is really there: the bare repository in this run's tmpdir. */
const TRANSPORT_REMOTE = 'seed'

/** The relay's own build, which is a separate package with its own `dist/`. */
const RELAY_ENTRY = join(REPO_ROOT, 'relay', 'dist', 'node', 'index.js')

/*
 * No shutdown deadline here, deliberately: a fixed budget (5s, then 20s) killed a
 * merely slow runtime under load and the discovery file the kill left behind was
 * reported as a leak. `TwoPeers.stop()` checks order, not speed; a hang is what
 * vitest's hook timeout is for. Orphans are the runtime's job: see the stdin guard
 * in `acceptance-host.mjs`.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the relay this harness dials has been built. */
export function relayIsBuilt() {
  return existsSync(RELAY_ENTRY)
}

/** Thrown by `linkPeers` when the relay package has not been built. */
export class RelayNotBuilt extends Error {
  constructor() {
    super(
      `${RELAY_ENTRY} is not there, so there is no relay for two peers to meet on. ` +
        'Build it with:  cd relay && npm ci && npm run build'
    )
    this.name = 'RelayNotBuilt'
  }
}

/**
 * Stands up two peers.
 *
 * @param {object} [options]
 * @param {string[]} [options.handles] Two handles. Order is leader, then joiner.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<TwoPeers>}
 */
export async function startTwoPeers(options = {}) {
  const [leaderHandle = 'ana', joinerHandle = 'bo'] = options.handles ?? []
  const log = options.log ?? (() => {})

  // Short on purpose. The runtime prefers a socket inside the user data dir and
  // falls back to $TMPDIR only when the path will not fit in sun_path, so a long
  // root here silently changes which endpoint is under test.
  const root = await mkdtemp(join(tmpdir(), 'tr-peers-'))
  const started = []

  try {
    // One bare repository both peers clone from and push to, reached as
    // `TRANSPORT_REMOTE`; `PROJECT_REMOTE` is what each clone calls origin.
    const seed = await createExampleRepo({ destination: join(root, 'seed'), withOrigin: true })
    const origin = seed.origin
    log(`origin at ${origin}`)

    for (const handle of [leaderHandle, joinerHandle]) {
      started.push(await startPeer({ root, origin, handle, log }))
    }

    const [leader, joiner] = started
    return new TwoPeers({ root, origin, leader, joiner, log })
  } catch (error) {
    for (const peer of started) await peer.stop().catch(() => {})
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function startPeer({ root, origin, handle, log }) {
  const home = join(root, handle)
  const userDataDir = join(home, 'userdata')
  const repoPath = join(home, 'ledger')

  // The runtime does not create this directory; a missing one surfaces later as
  // a failure to listen.
  await mkdir(userDataDir, { recursive: true })

  // A clone each, not a shared checkout: two clones can disagree about a branch.
  await run('git', ['clone', '--quiet', origin, repoPath])
  // A clone of a repository whose HEAD names an unpushed branch succeeds and
  // leaves an empty directory; every later step would then pass on nothing.
  if (!(await exists(join(repoPath, 'package.json')))) {
    throw new Error(`${handle}'s clone of ${origin} came up empty; check the origin's HEAD`)
  }
  await run('git', ['-C', repoPath, 'config', 'user.name', handle])
  await run('git', ['-C', repoPath, 'config', 'user.email', `${handle}@teamree.invalid`])

  // The rename carries the branch's tracking config with it, so pull and push go
  // on working without being told where.
  await run('git', ['-C', repoPath, 'remote', 'rename', 'origin', TRANSPORT_REMOTE])
  await run('git', ['-C', repoPath, 'remote', 'add', 'origin', PROJECT_REMOTE])

  // `detached` is not optional: npx puts two wrappers between us and the runtime
  // and a signal to the wrapper is not passed down, so the runtime would survive
  // holding its socket. Detached, the child leads a group the whole tree is in.
  const child = spawn('npx', ['tsx', RUNTIME_HOST], {
    env: {
      ...childEnv(process.env),
      TEAMREE_USER_DATA_DIR: userDataDir,
      TEAMREE_TEST_VERSION: `0.0.0-${handle}`,
      // A home each: git and npm read it too, and teardown has to cover
      // everything a peer touched.
      HOME: home,
      USERPROFILE: home,
      // npm's cache is keyed off the home, so name it back or every runtime
      // re-fetches `tsx`; this harness has to work offline.
      npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm')
    },
    // A pipe, never written to: how the runtime learns this process has died.
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })

  const output = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => output.push(chunk))
  child.stderr.on('data', (chunk) => output.push(chunk))

  let exited = null
  child.once('exit', (code, signal) => {
    exited = { code, signal }
  })

  const discoveryPath = join(userDataDir, DISCOVERY_FILE)
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (exited) {
        throw new Error(
          `${handle}'s runtime exited before it was ready (${JSON.stringify(exited)})` +
            `${whyItDied(output.join(''))}\n${output.join('')}`
        )
      }
      if (await exists(discoveryPath)) break
      await sleep(100)
    }
    if (!(await exists(discoveryPath))) {
      throw new Error(`${handle}'s runtime never published ${discoveryPath}\n${output.join('')}`)
    }

    const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
    const client = await connectToRuntime(discovery.endpoint)
    log(`${handle} listening on ${discovery.endpoint} (pid ${discovery.pid})`)

    return new Peer({ handle, home, userDataDir, repoPath, discoveryPath, discovery, client, child, output })
  } catch (error) {
    // A runtime that never became usable is still a running process.
    killTree(child, 'SIGKILL')
    throw error
  }
}

class Peer {
  /** @type {string | undefined} This peer's own clone, once the runtime has it. */
  projectId = undefined
  /** @type {{ handle: string | null, publicKey: string } | undefined} */
  identity = undefined

  constructor(fields) {
    Object.assign(this, fields)
  }

  /** One runtime call. The same catalogue the GUI and the CLI use. */
  call(method, params) {
    return this.client.call(method, params)
  }

  subscribe(method, params, onEvent) {
    return this.client.subscribe(method, params, onEvent)
  }

  /** Every method this peer's *user* has called, in order. */
  get called() {
    return this.client.called
  }

  /**
   * Tells this runtime about its own clone, once. Lazy so a test can observe a
   * runtime with no projects, or watch one being added.
   */
  async ensureProject() {
    if (this.projectId !== undefined) return this.projectId
    // Matched on the resolved path: the runtime stores the resolved root and
    // `$TMPDIR` is a symlink on macOS, so the raw spelling reads as a duplicate.
    const mine = await realpath(this.repoPath)
    const tracked = await this.call('project.list')
    const known = await findAsync(tracked, async (project) => (await realpath(project.path)) === mine)
    this.projectId = known?.id ?? (await this.call('project.add', { path: this.repoPath })).id
    return this.projectId
  }

  /**
   * Who this installation is, according to the installation: the keypair is
   * the runtime's own, not one the harness minted.
   */
  async whoAmI() {
    const list = await this.call('members.list', { projectId: await this.ensureProject() })
    this.identity = list.self
    return this.identity
  }

  /**
   * Writes this peer's public key into its own clone, through the app. Like the
   * Add my key button it stops at the file: no commit, no push.
   */
  async addSelfToRoster() {
    const list = await this.call('members.join', { projectId: await this.ensureProject(), handle: this.handle })
    this.identity = list.self
    return list.selfFile
  }

  /** Everyone this peer's clone currently knows about. */
  roster() {
    return readRoster(this.repoPath)
  }

  /** This peer's links to its teammates; an unread project reports none. */
  async links() {
    const status = await this.call('teamwork.status', { projectId: await this.ensureProject() })
    return status.state === 'read' ? status.links : []
  }

  /**
   * Waits until teamwork has reconciled a project this runtime was just given:
   * `project.add` answers before the peer service has read it, and until then
   * `teamwork.status` says `unread` rather than throwing.
   */
  async waitForTeamwork(options = {}) {
    await until(
      async () => {
        try {
          const status = await this.call('teamwork.status', { projectId: await this.ensureProject() })
          return status.state === 'read'
          // A runtime still opening its socket.
        } catch {
          return false
        }
      },
      `${this.handle}'s runtime to reconcile the project it was just given`,
      options.timeoutMs
    )
  }

  /** Waits until a teammate's session has authenticated and been confirmed. */
  async waitForLink(options = {}) {
    let seen = []
    await until(
      async () => {
        seen = await this.links()
        return seen.some((link) => link.phase === 'connected')
      },
      // Phases and the runtime's own words: a peer service that failed to start
      // is invisible from this end, since `startRuntime` reports it and carries
      // on serving, and without them every timeout reads as a relay race.
      () => `${this.handle} to connect to a teammate (last seen: ${JSON.stringify(seen)})${this.saidSoFar()}`,
      options.timeoutMs
    )
  }

  /** What this peer's runtime has written to its own output, if anything. */
  saidSoFar() {
    const said = this.output.join('').trim()
    return said === '' ? '' : `\n${this.handle}'s runtime said:\n${said}`
  }

  async gitPush() {
    await run('git', ['-C', this.repoPath, 'push', '--quiet', TRANSPORT_REMOTE, 'HEAD'])
  }

  /**
   * Rebase rather than fast-forward: two people committing their own key onto
   * the same base have diverged by the second pull, and `--ff-only` refuses.
   */
  async gitPull() {
    await run('git', ['-C', this.repoPath, 'pull', '--quiet', '--rebase', TRANSPORT_REMOTE, 'HEAD'])
  }

  async commit(message, paths) {
    await run('git', ['-C', this.repoPath, 'add', '--', ...paths])
    await run('git', ['-C', this.repoPath, 'commit', '--quiet', '-m', message])
  }

  async stop() {
    this.client.close()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return

    const ended = new Promise((resolve) => this.child.once('exit', resolve))
    // The runtime alone, not the group: tsx's wrapper, signalled too, SIGKILLs a child that
    // has not acknowledged within 60ms, which a runtime under load misses. Wrappers follow it out.
    if (process.platform === 'win32') killTree(this.child, 'SIGTERM')
    else signalRuntime(this.discovery.pid)
    await this.#wentQuietly()
    await ended
  }

  /**
   * Waits for the *runtime* to go, not the npx wrappers above it, which a tree kill
   * ends first. No deadline on purpose; see the note at the top.
   */
  async #wentQuietly() {
    while (isAlive(this.discovery.pid)) await sleep(25)
  }
}

export class TwoPeers {
  /** @type {{ url: string, stop: () => Promise<void> } | undefined} */
  relay = undefined
  /** @type {Peer[]} Anybody stood up after the pair — a stranger, a third member. */
  extras = []

  constructor({ root, origin, leader, joiner, log }) {
    this.root = root
    this.origin = origin
    this.leader = leader
    this.joiner = joiner
    this.log = log
  }

  get peers() {
    return [this.leader, this.joiner]
  }

  /** The pair and anybody added afterwards, which is what teardown owes. */
  get everyone() {
    return [...this.peers, ...this.extras]
  }

  /**
   * Puts the two peers on a real relay (a third child process, OS-picked port)
   * and waits until they have found each other. The relay is committed and
   * pulled, not set per machine: that is the order `docs/trying-teamwork.md`
   * gives a real pair.
   */
  async linkPeers(options = {}) {
    if (!relayIsBuilt()) throw new RelayNotBuilt()
    this.relay ??= await startRelay(this.log)
    for (const peer of this.peers) {
      await peer.ensureProject()
      await peer.waitForTeamwork(options)
    }

    await this.leader.call('teamwork.setRelay', { projectId: this.leader.projectId, url: this.relay.url })
    await this.leader.commit('Point the team at a relay', ['.teamree'])
    await this.leader.gitPush()
    // Nothing restarts: teamree watches `.teamree`, so the pull is what rebuilds
    // the joiner's links.
    await this.joiner.gitPull()

    try {
      await Promise.all(this.peers.map((peer) => peer.waitForLink(options)))
    } catch (error) {
      // A dead relay says more about the timeout than either peer can.
      const trouble = this.relay.trouble()
      throw trouble === '' ? error : new Error(`${error.message}\nand the relay is not well:\n${trouble}`)
    }
    return this.relay
  }

  /**
   * A third runtime on the pair's relay. Member or stranger is decided by the
   * repository, not by this call.
   */
  async addPeer(handle) {
    if (!this.relay) throw new Error('stand a relay up with linkPeers() first; a peer with no relay meets nobody')
    const peer = await startPeer({ root: this.root, origin: this.origin, handle, log: this.log })
    this.extras.push(peer)
    await peer.ensureProject()
    await peer.waitForTeamwork()
    return peer
  }

  /** Every clone, fetched back up to the origin. */
  async syncAll() {
    for (const peer of this.everyone) await peer.gitPull()
  }

  /** Tears everything down and returns whatever was left behind (should be empty). */
  async stop() {
    const leftovers = []
    // Relay first: outliving the peers it would hold its port into the next run.
    await this.relay?.stop()
    this.relay = undefined
    for (const peer of this.everyone) {
      await peer.stop().catch((error) => leftovers.push(`${peer.handle}: ${error.message}`))
      if (peer.child.exitCode === null && peer.child.signalCode === null) {
        leftovers.push(`${peer.handle}: runtime pid ${peer.child.pid} is still running`)
      }
      // The runtime removes its discovery file and unlinks its socket on a clean
      // shutdown. Either one left behind means the next run inherits a lie.
      if (await exists(peer.discoveryPath)) leftovers.push(`${peer.handle}: ${peer.discoveryPath} was left behind`)
      const endpoint = peer.discovery.endpoint
      if (!endpoint.startsWith('\\\\') && (await exists(endpoint))) {
        leftovers.push(`${peer.handle}: socket ${endpoint} was left behind`)
      }
    }
    await rm(this.root, { recursive: true, force: true })
    if (await exists(this.root)) leftovers.push(`${this.root} was left behind`)
    return leftovers
  }
}

/**
 * Signals a child and everything it spawned. On POSIX a negative pid addresses
 * the process group, which the child leads because it was spawned detached; on
 * Windows there are no groups, so `taskkill /T` walks the tree instead.
 *
 * Failures are swallowed deliberately: by the time this is called the tree is
 * usually already gone, and ESRCH is the success case arriving early.
 */
function killTree(child, signal) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    process.kill(-child.pid, signal)
  } catch {
    // Already gone.
  }
}

/** SIGTERMs one process; ESRCH means it is already gone. */
function signalRuntime(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/**
 * Names the one cause of a dead runtime that is not about this code at all.
 *
 * The host is TypeScript, transpiled from the working tree at spawn time, so a
 * write to any file it imports while it is being read kills the child with a
 * syntax error from halfway through somebody's edit. Measured here: an agent
 * saved `src/main/teamwork/peer/peerService.ts` during a run and the runtime
 * died on "Private name #currentProject must be declared in an enclosing
 * class", which is not a thing that file has ever said on disk.
 *
 * Said out loud because the shape of the failure points somewhere else
 * entirely: it arrives as a teamwork test failing at startup, and every reader
 * so far has gone hunting a race in the relay.
 */
function whyItDied(said) {
  if (!/Transform failed|TransformError|SyntaxError/.test(said)) return ''
  return (
    '. The host transpiles the working tree as it imports it, so this is what a ' +
    'source file being written mid-run looks like — check whether anything was ' +
    'saving into src/ while this ran, rather than reading it as a teamwork fault'
  )
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** `Array.prototype.find`, for a predicate that has to await something. */
async function findAsync(items, predicate) {
  for (const item of items) {
    if (await predicate(item)) return item
  }
  return undefined
}

/** Whether a pid is still a running process. Signal 0 asks and sends nothing. */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Polls a condition nothing here can be woken for.
 *
 * Two runtimes in two processes announce their changes to themselves and not
 * across a socket this harness is holding, so a link coming up is learned by
 * asking. The timeout is a failure mode rather than a delay: nothing waits for
 * it when the thing being waited on happens.
 */
async function until(predicate, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    // `what` may be a function so a caller can report the state it last saw,
    // which is the whole of what a reader of a timeout has to go on.
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${typeof what === 'function' ? what() : what}`)
    }
    await sleep(50)
  }
}

/**
 * The relay itself, as a child process on a port the OS picked.
 *
 * The port is read from the line the relay logs rather than guessed at: a
 * hard-coded one is how a harness starts failing the moment anything else on
 * the machine wants it, and two of these run side by side often enough.
 */
async function startRelay(log) {
  const child = spawn(process.execPath, [RELAY_ENTRY], {
    cwd: join(REPO_ROOT, 'relay'),
    env: {
      ...childEnv(process.env),
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: '0',
      // Wide enough that nothing here trips it, tight enough that a hanging
      // test is not waiting on the pairing budget.
      RELAY_PAIR_TIMEOUT_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const port = await new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.event === 'relay.listening' && typeof entry.port === 'number') {
            child.stdout.off('data', onData)
            resolve(entry.port)
            return
          }
        } catch {
          // Not a whole JSON line yet; keep reading.
        }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => reject(new Error(`the relay wrote to stderr: ${chunk.toString('utf8')}`)))
    child.once('exit', (code) => reject(new Error(`the relay exited with ${code} before it listened`)))
  })

  const url = `ws://127.0.0.1:${port}/v1/relay`
  log(`relay at ${url}`)

  // What the relay does after it is listening, which until now nothing watched.
  // A relay that dies mid-run is invisible from either peer's end — both of
  // them simply stop connecting — and the only symptom is a link that times
  // out, which reads as a fault in the peers. Kept here so the timeout can say
  // so instead.
  const trouble = []
  child.stderr.on('data', (chunk) => trouble.push(chunk.toString('utf8')))
  child.once('exit', (code, signal) => trouble.push(`the relay exited (${JSON.stringify({ code, signal })})`))

  return {
    url,
    /** Empty while the relay is healthy; the reason it is not, otherwise. */
    trouble: () => trouble.join('').trim(),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        // SIGTERM, because that is what a container runtime sends and what the
        // relay's own graceful shutdown is written for.
        child.kill('SIGTERM')
      })
  }
}

// ── Running it directly ─────────────────────────────────────────────────────

async function main(argv) {
  const keep = argv.includes('--keep')
  const log = (line) => process.stdout.write(`${line}\n`)

  const harness = await startTwoPeers({ log })
  let code = 0
  let failure
  try {
    code = await drive(harness, { keep, log })
  } catch (error) {
    failure = error
  }

  // Unconditional, including after a failure: the whole value of this harness is
  // that a failed run leaves no runtime behind either.
  const leftovers = await harness.stop()
  for (const leftover of leftovers) process.stderr.write(`two-peers: ${leftover}\n`)
  if (failure) throw failure
  // Something left running is a failure of the run, not a note at the end of a
  // successful one — otherwise the leak is reported and then exits 0 anyway.
  if (leftovers.length > 0) return 1

  log('Torn down, nothing left running.')
  return code
}

async function drive(harness, { keep, log }) {
  const { leader, joiner } = harness

  for (const peer of harness.peers) {
    await peer.addSelfToRoster()
    await peer.commit(`Add ${peer.handle} to the team`, ['.teamree'])
  }
  // Sequential on purpose: the second push is a non-fast-forward until it has
  // pulled, which is the thing two people adding keys at once will actually hit.
  await leader.gitPush()
  await joiner.gitPull()
  await joiner.gitPush()
  await leader.gitPull()

  log('')
  for (const peer of harness.peers) {
    const roster = await peer.roster()
    const status = await peer.call('status.get')
    log(`${peer.handle}: runtime ${status.version}, roster [${roster.map((row) => row.handle).join(', ')}]`)
  }

  // The relay, and then the wait for the two of them to authenticate each
  // other over it. A run that prints two peers and never says whether they met
  // is a run that proves the half nobody was worried about.
  if (relayIsBuilt()) {
    log('')
    await harness.linkPeers()
    for (const peer of harness.peers) {
      const links = await peer.links()
      log(`${peer.handle}: ${links.map((link) => `${link.handle} ${link.phase}`).join(', ') || 'nobody'}`)
    }
  } else {
    log('')
    log(new RelayNotBuilt().message)
  }

  if (keep) {
    log('')
    log('Both peers are up. Drive either one with the CLI:')
    for (const peer of harness.peers) {
      log(`  TEAMREE_USER_DATA_DIR=${peer.userDataDir} node out/cli/index.js status`)
    }
    log(`  ${leader.handle}'s checkout: ${leader.repoPath}`)
    log(`  ${joiner.handle}'s checkout: ${joiner.repoPath}`)
    log('')
    log('Ctrl-C to tear it all down.')
    await new Promise((resolve) => process.once('SIGINT', resolve))
    log('')
  }

  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`two-peers: ${error.stack ?? error.message}\n`)
    return 1
  })
}
