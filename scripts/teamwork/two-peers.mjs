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
// ═══ SEAM ═══
// The one thing missing is the part that is not built: the relay, and the peer
// transport that dials it. `linkPeers()` below is where it plugs in, and it
// refuses rather than pretending, because a harness that quietly no-ops the
// interesting half is a harness that passes forever.

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createExampleRepo } from '../../examples/init-example-repo.mjs'
import { generateIdentity, readRoster, writeMemberKey } from './identity.mjs'
import { connectToRuntime } from './peer-client.mjs'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RUNTIME_HOST = join(REPO_ROOT, 'scripts', 'acceptance-host.mjs')
const DISCOVERY_FILE = 'runtime.json'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Thrown by `linkPeers` until the peer transport exists. */
export class PeerTransportNotBuilt extends Error {
  constructor() {
    super(
      'the peer transport is not built yet: milestone B owns the relay and the Noise IK handshake. ' +
        'See the SEAM comment in scripts/teamwork/two-peers.mjs.'
    )
    this.name = 'PeerTransportNotBuilt'
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
    // One origin both peers clone from and push to. A bare repository stands in
    // for the git host a real team shares, and it is the right stand-in: what
    // membership actually depends on is push access, not which forge hosts it.
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

  const identity = generateIdentity(handle)

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
    env: { ...process.env, TEAMREE_USER_DATA_DIR: userDataDir, TEAMREE_TEST_VERSION: `0.0.0-${handle}` },
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

    return new Peer({ handle, identity, home, userDataDir, repoPath, discoveryPath, discovery, client, child, output })
  } catch (error) {
    // A runtime that never became usable is still a running process. Leaving it
    // behind is how one bad run turns into a machine full of orphans, and how
    // the next run fails for a reason that has nothing to do with the change.
    killTree(child, 'SIGKILL')
    throw error
  }
}

class Peer {
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

  /** Writes this peer's public key into its own clone. Does not commit. */
  addSelfToRoster() {
    return writeMemberKey(this.repoPath, this.identity)
  }

  /** Everyone this peer's clone currently knows about. */
  roster() {
    return readRoster(this.repoPath)
  }

  async gitPush() {
    await run('git', ['-C', this.repoPath, 'push', '--quiet', 'origin', 'HEAD'])
  }

  /**
   * Rebase rather than fast-forward. Two people who each commit their own key
   * onto the same base have diverged by the time the second one pulls, and
   * `--ff-only` simply refuses — which is correct, and useless, because the two
   * commits touch different files and the person is going to rebase anyway.
   * This is the first thing a real pair hits, so the harness hits it too.
   */
  async gitPull() {
    await run('git', ['-C', this.repoPath, 'pull', '--quiet', '--rebase'])
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
    const ordered = await Promise.race([ended.then(() => true), sleep(5000).then(() => false)])
    if (!ordered) {
      killTree(this.child, 'SIGKILL')
      await ended
    }
  }
}

export class TwoPeers {
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

  /**
   * ═══ SEAM ═══
   * Where the relay and the peer transport plug in.
   *
   * What has to happen here, and nothing of it is invented — it is what
   * `docs/teamwork.md` already decided:
   *
   *  1. A relay is reachable. A real team either deploys one or runs the
   *     container themselves — see `relay/README.md` — but neither belongs in a
   *     harness that has to run offline and leave nothing behind. Here it should
   *     be a third child process, started beside the two runtimes, torn down
   *     with them, and reachable at a URL this object hands both peers.
   *  2. Each peer opens an outbound WebSocket to it. Outbound-only is the whole
   *     point — neither side listens, so neither needs an address.
   *  3. The relay splices the two streams together. It learns who is paired and
   *     when, and nothing else.
   *  4. The peers run a Noise IK handshake over the splice, each authenticating
   *     the other against the static public key it read from
   *     `.teamree/members/<handle>.pub`. A peer whose key is not in the roster
   *     must fail here, and that failure is a test this harness should carry.
   *  5. After the handshake, a peer is a third transport onto the same method
   *     catalogue `call()` above already speaks.
   *
   * It refuses rather than resolving, so that every scenario step depending on
   * it is visibly pending instead of quietly vacuous.
   */
  async linkPeers() {
    throw new PeerTransportNotBuilt()
  }

  /** Both peers' clones, fetched back up to the origin. */
  async syncAll() {
    for (const peer of this.peers) await peer.gitPull()
  }

  /**
   * Tears everything down and checks it actually went. Returns the leftovers it
   * found, which should be empty: "nothing is still running" is the assertion a
   * harness has to make about itself before anybody trusts a test it ran.
   */
  async stop() {
    const leftovers = []
    for (const peer of this.peers) {
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
