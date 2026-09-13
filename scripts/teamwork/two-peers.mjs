#!/usr/bin/env node
// Two teamree peers on one machine.
//
// Teamwork will be debugged here far more often than it is debugged across two
// laptops, because two laptops cannot be put under a debugger, restarted a
// hundred times, or run in CI. So this stands up everything a real pair has
// except the distance: two runtimes, in two processes, with their own user data
// directories, their own identities, and their own clones of the same
// repository — and it tears all of it down afterwards.
//
//   node scripts/teamwork/two-peers.mjs           # stand up, self-check, tear down
//   node scripts/teamwork/two-peers.mjs --keep    # stand up and stay, for poking at
//
// The distance is the only thing it fakes, and it no longer fakes even that:
// `linkPeers()` runs the real relay as a third child process on a real port,
// and the two runtimes reach each other over it the way two laptops would.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createExampleRepo } from '../../examples/init-example-repo.mjs'
import { readRoster } from './identity.mjs'
import { connectToRuntime } from './peer-client.mjs'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RUNTIME_HOST = join(REPO_ROOT, 'scripts', 'acceptance-host.mjs')
const DISCOVERY_FILE = 'runtime.json'

/**
 * What every clone here calls `origin`, and the one thing about this harness
 * that is a stand-in rather than the real article.
 *
 * What makes two checkouts the same project is a hash of the normalised
 * `origin` URL, and "normalised" needs a host: a bare path is not a URL at all,
 * and `file://localhost/…` loses its host to the URL standard, which folds that
 * host back to nothing. Either one has both runtimes answer "the origin remote
 * is not a URL teamree can compare with a teammate's" and sit there — which is
 * teamwork correctly switched off, not teamwork under test.
 *
 * So `origin` is the address two people on two laptops would share, and the
 * bare repository they actually push to is a second remote. Nothing dials this
 * one; `gitPush` and `gitPull` name the other. What is under test is that both
 * machines derive the same project key from the same string, which is exactly
 * what a real pair's two clones of one forge repository do.
 */
const PROJECT_REMOTE = 'git@teamree.invalid:teamree/ledger.git'

/** The remote that is really there: the bare repository in this run's tmpdir. */
const TRANSPORT_REMOTE = 'seed'

/** The relay's own build, which is a separate package with its own `dist/`. */
const RELAY_ENTRY = join(REPO_ROOT, 'relay', 'dist', 'node', 'index.js')

/**
 * How long an ordered shutdown gets before the tree is killed instead.
 *
 * It is the *runtime's* budget and not the wrapper's: `npx` puts two processes
 * between here and the runtime, they die the instant the group is signalled,
 * and the runtime under them is still closing ptys and unlinking its socket.
 */
const SHUTDOWN_GRACE_MS = 5_000

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
    // One repository both peers clone from and push to. A bare repository
    // stands in for the git host a real team shares, and it is the right
    // stand-in: what membership actually depends on is push access, not which
    // forge hosts it. Each clone reaches it under `TRANSPORT_REMOTE` and calls
    // `PROJECT_REMOTE` its origin — see the note on that constant.
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

  // The runtime opens its store and binds its socket inside this directory but
  // does not create it, so a missing one surfaces much later as a failure to
  // listen rather than as the missing directory it is.
  await mkdir(userDataDir, { recursive: true })

  // A clone each, not a shared checkout. Two people do not share a working
  // directory, and a harness where they did would never see the class of bug
  // that only appears when two clones disagree about a branch.
  await run('git', ['clone', '--quiet', origin, repoPath])
  // Checked rather than assumed: a clone of a repository whose HEAD names a
  // branch nobody pushed succeeds, and leaves an empty directory behind. Every
  // later step then works on nothing, and the run passes while proving nothing.
  if (!(await exists(join(repoPath, 'package.json')))) {
    throw new Error(`${handle}'s clone of ${origin} came up empty; check the origin's HEAD`)
  }
  await run('git', ['-C', repoPath, 'config', 'user.name', handle])
  await run('git', ['-C', repoPath, 'config', 'user.email', `${handle}@teamree.invalid`])

  // The clone's `origin` becomes the transport remote and `origin` becomes the
  // address the team shares. The rename carries the branch's tracking config
  // with it, so pulling and pushing go on working without being told where.
  await run('git', ['-C', repoPath, 'remote', 'rename', 'origin', TRANSPORT_REMOTE])
  await run('git', ['-C', repoPath, 'remote', 'add', 'origin', PROJECT_REMOTE])

  // The host is a `.mjs` that imports TypeScript, so it needs a loader; tsx is
  // what the acceptance suite already uses for exactly this. Reached through npx
  // for the same reason it is there: so a clean checkout needs no extra step.
  //
  // `detached` is not optional here. npx puts two wrapper processes between us
  // and the runtime, and a signal sent to the wrapper is not passed down — the
  // runtime survives, holding its socket, and the next run inherits a stale
  // endpoint whose owner is still alive. Detaching makes the child a process
  // group leader so the whole tree can be signalled at once.
  const child = spawn('npx', ['tsx', RUNTIME_HOST], {
    env: {
      ...process.env,
      TEAMREE_USER_DATA_DIR: userDataDir,
      TEAMREE_TEST_VERSION: `0.0.0-${handle}`,
      // A home each. Worktree checkouts go to `~/.teamree/worktrees` and there
      // is no setting for it, so two peers sharing this process's home would
      // put their checkouts in one directory — and every run would leave one
      // behind in the home of whoever ran the suite, which makes "torn down,
      // nothing left running" untrue in the one way nobody would notice.
      HOME: home,
      USERPROFILE: home,
      // npm's cache is keyed off the home it is given, so it is named back
      // explicitly: without it every runtime would re-fetch `tsx` from the
      // network, and this harness has to work offline.
      npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
          `${handle}'s runtime exited before it was ready (${JSON.stringify(exited)})\n${output.join('')}`
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
    // A runtime that never became usable is still a running process. Leaving it
    // behind is how one bad run turns into a machine full of orphans, and how
    // the next run fails for a reason that has nothing to do with the change.
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
   * Tells this runtime about its own clone, once.
   *
   * Lazy rather than done at startup because a runtime that has been told
   * about no projects is a real state the harness wants to be able to observe,
   * and because adding one is a thing a test may want to watch happen.
   */
  async ensureProject() {
    if (this.projectId !== undefined) return this.projectId
    // Matched on the resolved path, because the runtime stores the repository
    // root it resolved and `$TMPDIR` is a symlink on macOS. Comparing the two
    // spellings would have this add a project the runtime already has and be
    // told, correctly, that it is a duplicate.
    const mine = await realpath(this.repoPath)
    const tracked = await this.call('project.list')
    const known = await findAsync(tracked, async (project) => (await realpath(project.path)) === mine)
    this.projectId = known?.id ?? (await this.call('project.add', { path: this.repoPath })).id
    return this.projectId
  }

  /**
   * Who this installation is, according to the installation.
   *
   * The keypair is the runtime's, generated on its first run and kept in its
   * own data directory. The harness used to mint one itself, which passed its
   * own tests while proving nothing: a roster full of keys the app has never
   * heard of authenticates nobody.
   */
  async whoAmI() {
    const list = await this.call('members.list', { projectId: await this.ensureProject() })
    this.identity = list.self
    return this.identity
  }

  /**
   * Writes this peer's public key into its own clone, through the app.
   *
   * `members.join` is the Add my key button in the Start teamwork panel, and it
   * writes the file and stops there — no staging, no commit, no push. Getting it
   * into the repository is the step the runbook makes a person do on purpose,
   * and a harness that did it silently would hide the one thing most likely to
   * be forgotten.
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

  /** How this peer's links to its teammates are going, in one project. */
  async links() {
    return (await this.call('teamwork.status', { projectId: await this.ensureProject() })).links
  }

  /**
   * Waits until teamwork has caught up with a project this runtime was just
   * given.
   *
   * `project.add` answers as soon as the project is in the store, and the peer
   * service reconciles against it afterwards on the workspace bus. Until it
   * has, `teamwork.status` answers "no project with id …" for a project the
   * store plainly has — so a caller that asked straight away would get an
   * error rather than a link that is not up yet.
   */
  async waitForTeamwork(options = {}) {
    await until(
      async () => {
        try {
          await this.call('teamwork.status', { projectId: await this.ensureProject() })
          return true
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
    const what = `${this.handle} to connect to a teammate`
    await until(async () => (await this.links()).some((link) => link.phase === 'connected'), what, options.timeoutMs)
  }

  async gitPush() {
    await run('git', ['-C', this.repoPath, 'push', '--quiet', TRANSPORT_REMOTE, 'HEAD'])
  }

  /**
   * Rebase rather than fast-forward. Two people who each commit their own key
   * onto the same base have diverged by the time the second one pulls, and
   * `--ff-only` simply refuses — which is correct, and useless, because the two
   * commits touch different files and the person is going to rebase anyway.
   * This is the first thing a real pair hits, so the harness hits it too.
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
    // SIGTERM asks the runtime to shut its PTYs down in order and to take its
    // discovery file and socket with it, which is the path worth exercising.
    // SIGKILL is the backstop, not the plan: a harness that always killed would
    // never notice the day clean shutdown started hanging.
    killTree(this.child, 'SIGTERM')
    const ordered = await this.#wentQuietly()
    if (!ordered) killTree(this.child, 'SIGKILL')
    await ended
  }

  /**
   * Whether the *runtime* has gone, not whether the wrapper that spawned it
   * has.
   *
   * `npx` sits two processes above the runtime and both die the moment the
   * process group is signalled, while the runtime under them is still closing
   * ptys, flushing its store and unlinking its socket. A harness that waited on
   * the wrapper and then asked whether the discovery file was gone would lose
   * that race under load — and would lose it as "the runtime leaked", which is
   * a lie about the code under test rather than a report about it.
   */
  async #wentQuietly() {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    while (Date.now() < deadline) {
      if (!isAlive(this.discovery.pid) && !(await exists(this.discoveryPath))) return true
      await sleep(25)
    }
    return false
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
   * Puts the two peers on a relay and waits until they have found each other.
   *
   * Everything here is the real thing. The relay is its own build, run as a
   * third child process on a port the OS picks, torn down with the runtimes.
   * Each peer opens an outbound WebSocket to it and neither listens, so neither
   * needs an address. The relay splices the two streams and learns who is
   * paired and when, and nothing else: the Noise `IK` handshake runs over the
   * splice, each side authenticating the other against the static public key it
   * read from `.teamree/members/<handle>.pub`, so the relay carries ciphertext.
   * After that a teammate is a third transport onto the catalogue `call()`
   * already speaks.
   *
   * The relay is committed rather than set per machine, because that is what
   * `docs/trying-teamwork.md` tells a real pair to do and it is the order that
   * matters: one person writes `.teamree/relay`, commits it and pushes, and the
   * other gets the team's relay in a pull. Two machines each writing their own
   * copy would leave two dirty checkouts and make the one team-wide fact a
   * per-machine setting.
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
    // Nothing restarts. teamree watches `.teamree` in each checkout, so the
    // pull that brings the relay in is what rebuilds the joiner's links — and
    // a harness that restarted here would be proving a runbook step that says
    // the opposite.
    await this.joiner.gitPull()

    await Promise.all(this.peers.map((peer) => peer.waitForLink(options)))
    return this.relay
  }

  /**
   * A third runtime, with its own clone, its own identity and its own data
   * directory, on the relay the pair is already using.
   *
   * Who they are is decided by the repository and not by this call: a handle
   * whose key nobody committed is a stranger, and the same runtime becomes a
   * member the moment somebody pushes their `.pub`.
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

  /**
   * Tears everything down and checks it actually went. Returns the leftovers it
   * found, which should be empty: "nothing is still running" is the assertion a
   * harness has to make about itself before anybody trusts a test it ran.
   */
  async stop() {
    const leftovers = []
    // Before the runtimes: a relay outliving the peers it spliced would hold
    // its port into the next run, and the peers have nothing to say to it once
    // they are being shut down anyway.
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
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
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
      ...process.env,
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
  return {
    url,
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
