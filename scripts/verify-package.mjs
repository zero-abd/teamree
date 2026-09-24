// Proves a packaged build works: launches it on a throwaway user-data dir, drives it through the
// shipped CLI and opens a real PTY. `npm run package:verify` finds the artifact in dist/, or name one.
// The PTY is the point: only spawning a shell proves node-pty's unpacked binaries survived packaging.
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withoutSystemCa } from './child-env.mjs'
import { electronSandboxArgs } from './electron-sandbox.mjs'
import { packagedAppCandidates } from './packaged-app.mjs'

const MARKER = `pty-ok-${Math.random().toString(36).slice(2, 10)}`
const STARTUP_TIMEOUT_MS = 45_000
const STEP_TIMEOUT_MS = 30_000

function fail(message, detail) {
  console.error(`verify-package: FAIL ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}

function ok(message) {
  console.log(`verify-package: ok — ${message}`)
}

// ------------------------------------------------------------ the artifact --

/** Best-effort version of a candidate, so an ambiguous dist names both builds. */
function describeVersion(candidate) {
  const plist = join(candidate, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return 'version unknown'
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, 'utf8'))
  return match ? `version ${match[1]}` : 'version unknown'
}

/** Layout of a packaged app differs per platform; everything else does not. */
function locateApp(explicit) {
  const candidates = explicit ? [explicit] : packagedAppCandidates()

  const present = candidates.filter((candidate) => existsSync(candidate))
  if (present.length === 0) fail(`no packaged app found. Looked for: ${candidates.join(', ')}`)

  // A verification that passes against a stale app is worse than none, so ambiguous is a refusal.
  if (present.length > 1) {
    fail(
      `more than one packaged app is in dist/, so it is not clear which one to verify:\n` +
        present.map((candidate) => `  ${candidate}  (${describeVersion(candidate)})`).join('\n') +
        `\nRemove the ones you do not mean to check, or name one:  npm run package:verify -- <path>`
    )
  }

  const root = present[0]

  if (process.platform === 'darwin') {
    return {
      root,
      binary: join(root, 'Contents', 'MacOS', 'teamree'),
      resources: join(root, 'Contents', 'Resources'),
      launcher: join(root, 'Contents', 'Resources', 'cli', 'teamree')
    }
  }
  return {
    root,
    binary: join(root, process.platform === 'win32' ? 'teamree.exe' : 'teamree'),
    resources: join(root, 'resources'),
    launcher: join(root, 'resources', 'cli', process.platform === 'win32' ? 'teamree.cmd' : 'teamree')
  }
}

const app = locateApp(process.argv[2])
console.log(`verify-package: checking ${app.root}`)

for (const path of [app.binary, app.resources, app.launcher, join(app.resources, 'cli', 'teamree.mjs')]) {
  if (!existsSync(path)) fail(`missing from the package: ${path}`)
}
ok('app binary and shipped CLI are in place')

// ------------------------------------------------- the relay it ships with --

// The app carries the relay's deployable project so a .dmg user needs no clone; check each file
// is really in the package, then run the launcher for real.
const relayRoot = join(app.resources, 'relay')
const relayLauncher = join(relayRoot, process.platform === 'win32' ? 'teamree-relay.cmd' : 'teamree-relay')
const relayFiles = [
  relayLauncher,
  join(relayRoot, 'bin', 'teamree-relay.mjs'),
  join(relayRoot, 'wrangler.jsonc'),
  join(relayRoot, 'src', 'workers', 'worker.ts'),
  join(relayRoot, 'src', 'core', 'rendezvous.ts'),
  // The Node host `teamree-relay serve` copies out; missing, it fails after a write, install and build.
  join(relayRoot, 'src', 'node', 'server.ts')
]
for (const path of relayFiles) {
  if (!existsSync(path)) fail(`the relay is not in the package: ${path} is missing, so a .dmg user still needs a clone`)
}
if (process.platform !== 'win32' && !(statSync(relayLauncher).mode & 0o111)) {
  fail(`${relayLauncher} is not executable, so the one command in relay/README.md would not run`)
}

// The command short of Wrangler. No deploy (needs an account) and no `--dry-run` (fetches Wrangler).
{
  const isCmd = relayLauncher.endsWith('.cmd')
  const runRelayCommand = (args) =>
    spawnSync(isCmd ? process.env.ComSpec || 'cmd.exe' : relayLauncher, isCmd ? ['/c', relayLauncher, ...args] : args, {
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      env: withoutSystemCa(process.env)
    })

  const target = join(mkdtempSync(join(tmpdir(), 'teamree-verify-relay-')), 'relay')
  const result = runRelayCommand(['deploy', target, '--write-only'])
  if (result.status !== 0) {
    fail(`the shipped relay command failed to write a project`, `${result.stdout}\n${result.stderr}`)
  }
  for (const name of ['wrangler.jsonc', join('src', 'workers', 'worker.ts'), 'package.json', 'README.md']) {
    if (!existsSync(join(target, name))) fail(`the shipped relay command wrote no ${name} into ${target}`)
  }
  rmSync(dirname(target), { recursive: true, force: true })
  ok('the shipped relay command wrote a deployable Worker project from inside the package')

  // `serve`, stopped at `--write-only` likewise: what packaging could break is a source file
  // missing from the bundle, and writing the project proves that.
  const serveTarget = join(mkdtempSync(join(tmpdir(), 'teamree-verify-serve-')), 'relay-server')
  const served = runRelayCommand(['serve', serveTarget, '--write-only'])
  if (served.status !== 0) {
    fail(`the shipped relay command failed to write a server project`, `${served.stdout}\n${served.stderr}`)
  }
  for (const name of [
    join('src', 'node', 'index.ts'),
    join('src', 'node', 'server.ts'),
    join('src', 'core', 'config.ts'),
    'package.json',
    'tsconfig.json',
    'README.md'
  ]) {
    if (!existsSync(join(serveTarget, name))) fail(`the shipped relay command wrote no ${name} into ${serveTarget}`)
  }
  // Read rather than assumed: the build lands in `dist/node/index.js` and the server imports `ws`.
  const servedPackage = JSON.parse(readFileSync(join(serveTarget, 'package.json'), 'utf8'))
  if (servedPackage.dependencies?.ws === undefined) {
    fail(`the written server project asks for no ws, so it would build and then fail to start`)
  }
  if (servedPackage.scripts?.start !== 'node dist/node/index.js') {
    fail(`the written server project starts with ${servedPackage.scripts?.start}, which is not where the build lands`)
  }
  const servedTsconfig = JSON.parse(readFileSync(join(serveTarget, 'tsconfig.json'), 'utf8'))
  if (servedTsconfig.compilerOptions?.rootDir !== 'src' || servedTsconfig.compilerOptions?.outDir !== 'dist') {
    fail(`the written server project compiles somewhere other than src -> dist, so npm start would find nothing`)
  }
  rmSync(dirname(serveTarget), { recursive: true, force: true })
  ok('the shipped relay command wrote a runnable Node relay project from inside the package')
}

// ------------------------------------------------------- static PTY checks --

const ptyRoot = join(app.resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
if (!existsSync(ptyRoot)) fail(`node-pty is not unpacked from the asar (expected ${ptyRoot})`)

const binaryDirs = [
  join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`),
  join(ptyRoot, 'build', 'Release')
].filter((dir) => existsSync(join(dir, 'pty.node')))
if (binaryDirs.length === 0) fail(`node-pty ships no pty.node for ${process.platform}-${process.arch} in ${ptyRoot}`)
ok(`node-pty binary for ${process.platform}-${process.arch} is unpacked (${binaryDirs[0]})`)

// macOS only: node-pty builds spawn-helper under `OS=="mac"`; Linux execvp's in process and ships none.
// Both architectures, statically: `node-gyp-build` picks `prebuilds/darwin-<arch>` at run time, so the
// launch below only ever exercises this machine's half, and every Mac that packages this is Apple
// Silicon. A Mach-O check per directory catches a merge that wrote one slice into both and a file cut
// off before its load commands end. Until Rosetta or an Intel Mac runs the x64 slice it is asserted, not shown.
const CPU_TYPES = new Map([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64'],
  [0x00000007, 'ia32'],
  [0x0000000c, 'arm']
])

/**
 * A Mach-O's architectures and the smallest size it could be and still be whole: the end of the
 * load commands (thin) or the last slice (fat). `arches` is empty for a non-Mach-O.
 */
function machoHeader(path) {
  const head = Buffer.alloc(4096)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  const nothing = { arches: [], declared: 0 }
  if (read < 8) return nothing

  const name = (cpu) => CPU_TYPES.get(cpu) ?? `cputype ${cpu}`

  // A fat header is big-endian by definition, whatever is inside it.
  const fat = head.readUInt32BE(0)
  if (fat === 0xcafebabe || fat === 0xcafebabf) {
    const wide = fat === 0xcafebabf
    const stride = wide ? 32 : 20
    const arches = []
    let declared = 0
    for (let i = 0; i < head.readUInt32BE(4); i += 1) {
      const at = 8 + i * stride
      if (at + stride > read) break
      arches.push(name(head.readUInt32BE(at)))
      // fat_arch has 32-bit offset and size; fat_arch_64 widens both and adds a reserved word (20 vs 32).
      const offset = wide ? Number(head.readBigUInt64BE(at + 8)) : head.readUInt32BE(at + 8)
      const size = wide ? Number(head.readBigUInt64BE(at + 16)) : head.readUInt32BE(at + 12)
      declared = Math.max(declared, offset + size)
    }
    return { arches, declared }
  }

  // A thin header carries its own byte order: MH_MAGIC one way round, MH_CIGAM the other.
  for (const [magic, read32] of [
    [head.readUInt32LE(0), (at) => head.readUInt32LE(at)],
    [head.readUInt32BE(0), (at) => head.readUInt32BE(at)]
  ]) {
    if (magic !== 0xfeedface && magic !== 0xfeedfacf) continue
    // mach_header is 28 bytes, mach_header_64 is 32; sizeofcmds is at offset 20 in both.
    const headerSize = magic === 0xfeedfacf ? 32 : 28
    return { arches: [name(read32(4))], declared: headerSize + (read >= 24 ? read32(20) : 0) }
  }
  return nothing
}

// `npm_config_build_from_source` makes node-pty delete `prebuilds` and compile into build/Release;
// such a package legitimately has no darwin-* directories and no second slice to check.
const prebuilds = join(ptyRoot, 'prebuilds')
const shipsPrebuilds = existsSync(prebuilds) && readdirSync(prebuilds).some((entry) => entry.startsWith('darwin-'))

if (process.platform === 'darwin' && shipsPrebuilds) {
  // scripts/afterpack.mjs keeps every `darwin-*` set in every macOS package; one missing is a fault.
  for (const arch of ['arm64', 'x64']) {
    const dir = join(prebuilds, `darwin-${arch}`)
    if (!existsSync(dir)) fail(`node-pty has no darwin-${arch} prebuild in ${ptyRoot}`)

    for (const name of ['pty.node', 'spawn-helper']) {
      const path = join(dir, name)
      if (!existsSync(path)) fail(`${name} is missing from ${dir}`)

      // Only spawn-helper is exec'd; pty.node is dlopen'd and ships 0644.
      const mode = statSync(path).mode & 0o777
      if (name === 'spawn-helper' && !(mode & 0o111)) {
        fail(`${path} is not executable (mode ${mode.toString(8)}); every PTY spawn on ${arch} would fail`)
      }

      const { arches, declared } = machoHeader(path)
      if (arches.length === 0) fail(`${path} is not a Mach-O binary`)
      if (!arches.includes(arch)) {
        fail(
          `${path} is a Mach-O for ${arches.join(', ')}, not ${arch}.`,
          'A darwin-<arch> prebuild directory holding another architecture is a merge that went wrong: ' +
            'the app would load it on that architecture and fail to open any terminal.'
        )
      }
      const bytes = statSync(path).size
      if (bytes < declared) {
        fail(
          `${path} is ${bytes} bytes; its own Mach-O header accounts for ${declared}.`,
          'The file was cut short after it was built. It would fail to load rather than fail to work.'
        )
      }
      ok(`darwin-${arch}/${name}: ${arches.join(', ')}, ${bytes} bytes, mode ${mode.toString(8)}`)
    }
  }
  // Said plainly: the PASS line below runs the app as one architecture.
  ok(`both darwin slices check out statically; only ${process.arch} is executed below`)
}

// node-pty picks ConPTY or winpty at spawn time; a missing one only shows when a pane refuses to open.
if (process.platform === 'win32') {
  const required = ['conpty.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe']
  const missing = required.filter((name) => !existsSync(join(binaryDirs[0], name)))
  if (missing.length > 0) fail(`node-pty is missing ${missing.join(', ')} from ${binaryDirs[0]}`)
  const conpty = join(binaryDirs[0], 'conpty')
  const sidecars = ['conpty.dll', 'OpenConsole.exe'].filter((name) => !existsSync(join(conpty, name)))
  if (sidecars.length > 0)
    fail(`node-pty's bundled ConPTY is incomplete: ${sidecars.join(', ')} missing from ${conpty}`)
  ok('both Windows PTY backends and the bundled ConPTY are unpacked')
}

// ------------------------------------------------------------- the fixture --

const scratch = mkdtempSync(join(tmpdir(), 'teamree-verify-'))
const userData = join(scratch, 'user-data')
const repo = join(scratch, 'repo')
mkdirSync(userData, { recursive: true })
mkdirSync(repo, { recursive: true })

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'teamree verify',
  GIT_AUTHOR_EMAIL: 'verify@teamree.invalid',
  GIT_COMMITTER_NAME: 'teamree verify',
  GIT_COMMITTER_EMAIL: 'verify@teamree.invalid'
}
function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' })
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`, result.stderr)
}
git('init', '-b', 'main')
git('commit', '--allow-empty', '-m', 'initial')
ok(`fixture repository at ${repo}`)

// --------------------------------------------------------- launch the app --

// A throwaway --user-data-dir keeps the single-instance lock from handing the run to an app the
// developer already has open, and the mock keychain keeps its cookie key out of the login keychain.
// TEAMREE_BACKGROUND_LAUNCH stops the window stealing focus.
const child = spawn(app.binary, [`--user-data-dir=${userData}`, '--use-mock-keychain', ...electronSandboxArgs()], {
  // The checkout goes under the same scratch, so nothing lands in the folder the real app lists.
  env: {
    ...withoutSystemCa(process.env),
    TEAMREE_BACKGROUND_LAUNCH: '1',
    TEAMREE_WORKTREES_ROOT: join(scratch, 'worktrees')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appOutput = ''
child.stdout.on('data', (chunk) => (appOutput += chunk))
child.stderr.on('data', (chunk) => (appOutput += chunk))
child.on('error', (error) => fail(`could not launch ${app.binary}`, String(error)))

let exited = null
child.on('exit', (code, signal) => (exited = { code, signal }))

// Handed back through the app first, so the runtime knows it is gone and the branch goes with it.
let createdWorktree = null

function cleanup() {
  if (createdWorktree && !exited) {
    try {
      cliQuiet('worktree', 'remove', createdWorktree.id, '--force', '--delete-branch')
      cliQuiet('project', 'remove', 'verify')
    } catch {
      // Best effort: a failed run has already reported the real problem.
    }
    try {
      rmSync(createdWorktree.path, { recursive: true, force: true })
      rmdirSync(join(createdWorktree.path, '..'))
    } catch {
      // Already gone, or shared with another project's worktrees.
    }
  }
  if (!exited) child.kill('SIGTERM')
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // A terminal may still hold the socket open; the temp dir is disposable.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const discovery = join(userData, 'runtime.json')
const startedAt = Date.now()
while (!existsSync(discovery)) {
  if (exited) {
    cleanup()
    fail(`the app exited (code ${exited.code}, signal ${exited.signal}) before its runtime came up`, appOutput)
  }
  if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
    cleanup()
    fail(`no discovery file at ${discovery} after ${STARTUP_TIMEOUT_MS}ms`, appOutput)
  }
  await sleep(250)
}
const record = JSON.parse(readFileSync(discovery, 'utf8'))
ok(`app launched: pid ${record.pid}, version ${record.version}, endpoint ${record.endpoint}`)

// ----------------------------------------------- drive it through the CLI --

/** Runs the CLI exactly as a user with it on PATH would. */
function cli(...args) {
  const isCmd = app.launcher.endsWith('.cmd')
  const result = spawnSync(
    isCmd ? process.env.ComSpec || 'cmd.exe' : app.launcher,
    isCmd ? ['/c', app.launcher, ...args] : args,
    {
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      env: { ...withoutSystemCa(process.env), TEAMREE_USER_DATA_DIR: userData }
    }
  )
  if (result.error) {
    cleanup()
    fail(`teamree ${args.join(' ')} could not run`, String(result.error))
  }
  if (result.status !== 0) {
    cleanup()
    fail(`teamree ${args.join(' ')} exited ${result.status}`, `${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

/** Same launcher, but a failure is not worth aborting teardown over. */
function cliQuiet(...args) {
  const isCmd = app.launcher.endsWith('.cmd')
  spawnSync(isCmd ? process.env.ComSpec || 'cmd.exe' : app.launcher, isCmd ? ['/c', app.launcher, ...args] : args, {
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    env: { ...withoutSystemCa(process.env), TEAMREE_USER_DATA_DIR: userData }
  })
}

function cliJson(...args) {
  const text = cli(...args, '--json')
  try {
    return JSON.parse(text)
  } catch (error) {
    cleanup()
    fail(`teamree ${args.join(' ')} --json did not return JSON`, `${String(error)}\n${text}`)
  }
}

const status = cliJson('status')
ok(`shipped CLI reached the packaged runtime (status: ${JSON.stringify(status.data ?? status)})`)

// ------------------------------------------- what the app says about its CLI --

// The first-run offer rests on this read, and only a packaged app can answer it (`process.resourcesPath`).
// The install is not driven from here: it writes to /usr/local/bin as root, deliberately not configurable,
// and is covered in src/main/cli/cliService.test.ts and registerCliHandlers.test.ts.
const cliStatus = cliJson('cli', 'status').data
const shippedCli = join(app.resources, 'cli', 'teamree')

function wrongAboutItsCli() {
  if (!cliStatus.source) return 'it reports no CLI of its own'
  if (!existsSync(cliStatus.source)) return `it would link ${cliStatus.source}, and nothing is there`
  if (realpathSync(cliStatus.source) !== realpathSync(shippedCli)) {
    return `it would link ${cliStatus.source}, which is not the CLI in this package (${shippedCli})`
  }
  if (!cliStatus.packaged) return 'it does not know it is packaged, so it would never make the first-run offer'
  if (!cliStatus.bundle || !existsSync(cliStatus.bundle)) {
    return `it names ${cliStatus.bundle} as the bundle behind its launcher, and nothing is there`
  }
  if (cliStatus.destination !== '/usr/local/bin/teamree') return `it would put the link at ${cliStatus.destination}`
  return null
}

const wrong = wrongAboutItsCli()
if (wrong) {
  cleanup()
  fail(`the packaged app is wrong about its own CLI: ${wrong}`, JSON.stringify(cliStatus, null, 2))
}
if (cliStatus.impermanent !== null) {
  // Not a failure: a copy run from the disk image refuses to link rather than dangle at the eject.
  ok(`the app knows it is running from somewhere a link cannot follow (${cliStatus.impermanent})`)
}
ok(`the app finds its own CLI at ${cliStatus.source}, with the bundle at ${cliStatus.bundle}`)

cliJson('project', 'add', repo, '--name', 'verify')

// Creation is asynchronous, so poll the list.
const created = cliJson('worktree', 'create', '--project', 'verify', '--name', 'verify').data
let worktree = created
const waitUntil = Date.now() + STEP_TIMEOUT_MS
while (worktree.state !== 'ready' && Date.now() < waitUntil) {
  await sleep(500)
  const rows = cliJson('worktree', 'list').data ?? []
  worktree = rows.find((row) => row.id === created.id) ?? worktree
  if (worktree.state === 'failed') break
}
if (worktree.state !== 'ready') {
  cleanup()
  fail(`the worktree never became ready (state ${worktree.state})`, appOutput)
}
createdWorktree = worktree
ok(`worktree ${worktree.id} (${worktree.branch}) at ${worktree.path}`)

// ------------------------------------------------------------ the real PTY --

const terminal = cliJson('terminal', 'create', '--worktree', worktree.id).data
ok(`PTY spawned inside the packaged app: ${terminal.id}, shell ${terminal.shell}, cwd ${terminal.cwd}`)

cli('terminal', 'send', terminal.id, '--text', `echo ${MARKER}`, '--enter')

let output = ''
const readUntil = Date.now() + STEP_TIMEOUT_MS
while (Date.now() < readUntil) {
  await sleep(400)
  output = cliJson('terminal', 'read', terminal.id).data.data
  // The echoed command line holds the marker too, so wait for it twice.
  if (output.split(MARKER).length > 2) break
}

if (output.split(MARKER).length <= 2) {
  cleanup()
  fail(`the shell never echoed ${MARKER} back; scrollback was:\n${output}`, appOutput)
}
ok(`the shell inside the packaged app ran a command and its output came back (${MARKER})`)

console.log('\n----- terminal scrollback from the packaged app -----')
console.log(output.trimEnd())
console.log('-----------------------------------------------------\n')

cleanup()
console.log(
  `verify-package: PASS — packaged app launches, ships a working CLI, and spawns a real PTY on ${process.platform}-${process.arch}`
)
