// Proves that a packaged build actually works, rather than that it merely
// built. Run after `npm run package` (or `npm run package:dir`):
//
//   npm run package:verify            # finds the artifact in dist/
//   node scripts/verify-package.mjs "/Applications/teamree.app"
//
// It launches the packaged app against a throwaway user-data directory, drives
// it through the CLI the app itself ships, opens a real PTY inside it and reads
// back what the shell printed. The PTY is the point: node-pty needs its native
// binary outside the asar, plus an executable spawn-helper on macOS and two
// backends and a sidecar on Windows, and nothing short of spawning a shell
// proves all of that survived packaging.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronSandboxArgs } from './electron-sandbox.mjs'

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
  const candidates = explicit
    ? [explicit]
    : process.platform === 'darwin'
      ? ['dist/mac-arm64/teamree.app', 'dist/mac/teamree.app', 'dist/mac-universal/teamree.app']
      : process.platform === 'win32'
        ? ['dist/win-unpacked']
        : ['dist/linux-unpacked']

  const present = candidates.filter((candidate) => existsSync(candidate))
  if (present.length === 0) fail(`no packaged app found. Looked for: ${candidates.join(', ')}`)

  // Taking the first match silently verified whichever build happened to be
  // listed earliest, which on a machine that has packaged more than once is the
  // older one. A verification that passes against a stale app is worse than no
  // verification, so an ambiguous dist is a refusal rather than a guess.
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

// ------------------------------------------------------- static PTY checks --

const ptyRoot = join(app.resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
if (!existsSync(ptyRoot)) fail(`node-pty is not unpacked from the asar (expected ${ptyRoot})`)

const binaryDirs = [
  join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`),
  join(ptyRoot, 'build', 'Release')
].filter((dir) => existsSync(join(dir, 'pty.node')))
if (binaryDirs.length === 0) fail(`node-pty ships no pty.node for ${process.platform}-${process.arch} in ${ptyRoot}`)
ok(`node-pty binary for ${process.platform}-${process.arch} is unpacked (${binaryDirs[0]})`)

// macOS only: node-pty builds spawn-helper under `OS=="mac"` and calls it from
// a `#if defined(__APPLE__)` branch. Linux execvp's in process and ships none.
if (process.platform === 'darwin') {
  const helper = join(binaryDirs[0], 'spawn-helper')
  if (!existsSync(helper)) fail(`spawn-helper is missing from ${binaryDirs[0]}`)
  const mode = statSync(helper).mode & 0o777
  if (!(mode & 0o111)) fail(`spawn-helper is not executable (mode ${mode.toString(8)})`)
  ok(`spawn-helper is unpacked and executable (mode ${mode.toString(8)})`)
}

// node-pty chooses its Windows backend at spawn time — ConPTY from conpty.node,
// or winpty, which needs a DLL and a separate agent executable beside pty.node.
// A missing one only shows up when a pane refuses to open, so name it here.
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

// A throwaway --user-data-dir keeps this off the real profile, and keeps the
// single-instance lock from handing the run to an app the developer already has
// open. TEAMREE_BACKGROUND_LAUNCH stops the window from stealing focus.
const child = spawn(app.binary, [`--user-data-dir=${userData}`, ...electronSandboxArgs()], {
  env: { ...process.env, TEAMREE_BACKGROUND_LAUNCH: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appOutput = ''
child.stdout.on('data', (chunk) => (appOutput += chunk))
child.stderr.on('data', (chunk) => (appOutput += chunk))
child.on('error', (error) => fail(`could not launch ${app.binary}`, String(error)))

let exited = null
child.on('exit', (code, signal) => (exited = { code, signal }))

// Worktree checkouts are created under the user's home, not under the scratch
// directory, so they have to be handed back before the app goes away.
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
      env: { ...process.env, TEAMREE_USER_DATA_DIR: userData }
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
    env: { ...process.env, TEAMREE_USER_DATA_DIR: userData }
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

// Everything the first-run offer says rests on this one read, and only a real
// packaged app can answer it: the app finds its own CLI through
// `process.resourcesPath`. Every claim is checked against the package on disk,
// because a status naming a path with nothing at it is a panel offering to link
// one — and an offer made from the wrong place costs somebody a password.
//
// The install itself is not driven from here. It writes to /usr/local/bin, and
// that destination is deliberately not configurable: an environment variable
// that moved it would let the environment choose the target of a symlink
// written as root. Linking is covered against a temporary directory in
// src/main/cli/cliService.test.ts and through the real dispatcher in
// registerCliHandlers.test.ts; what only a packaged app can answer is here.
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
  // Not a packaging fault and not a failure: it is what the app should say
  // about a copy being run from the disk image, and from there it refuses to
  // link rather than leaving a symlink that dangles at the eject.
  ok(`the app knows it is running from somewhere a link cannot follow (${cliStatus.impermanent})`)
}
ok(`the app finds its own CLI at ${cliStatus.source}, with the bundle at ${cliStatus.bundle}`)

cliJson('project', 'add', repo, '--name', 'verify')

// Creation is asynchronous by design, so poll the list rather than leaning on
// any one wait command staying in the CLI surface.
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
  // The echoed command line contains the marker too, so wait for it twice:
  // once as the keystrokes, once as the shell's own output.
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
console.log('verify-package: PASS — packaged app launches, ships a working CLI, and spawns a real PTY')
