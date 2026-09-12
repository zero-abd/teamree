// Proves that a packaged build actually works, rather than that it merely
// built. Run after `npm run package` (or `npm run package:dir`):
//
//   npm run package:verify            # finds the artifact in dist/
//   node scripts/verify-package.mjs "/Applications/teamree.app"
//
// It launches the packaged app against a throwaway user-data directory, drives
// it through the CLI the app itself ships, opens a real PTY inside it and reads
// back what the shell printed. The PTY is the point: node-pty needs its native
// binary and its spawn-helper outside the asar with the executable bit intact,
// and nothing short of spawning one proves that survived packaging.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** Layout of a packaged app differs per platform; everything else does not. */
function locateApp(explicit) {
  const candidates = explicit
    ? [explicit]
    : process.platform === 'darwin'
      ? ['dist/mac-arm64/teamree.app', 'dist/mac/teamree.app', 'dist/mac-universal/teamree.app']
      : process.platform === 'win32'
        ? ['dist/win-unpacked']
        : ['dist/linux-unpacked']

  const root = candidates.find((candidate) => existsSync(candidate))
  if (!root) fail(`no packaged app found. Looked for: ${candidates.join(', ')}`)

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
].filter((dir) => existsSync(dir))
if (binaryDirs.length === 0) fail(`node-pty ships no binary for ${process.platform}-${process.arch} in ${ptyRoot}`)

if (process.platform !== 'win32') {
  const helper = join(binaryDirs[0], 'spawn-helper')
  if (!existsSync(helper)) fail(`spawn-helper is missing from ${binaryDirs[0]}`)
  const mode = statSync(helper).mode & 0o777
  if (!(mode & 0o111)) fail(`spawn-helper is not executable (mode ${mode.toString(8)})`)
  ok(`spawn-helper is unpacked and executable (mode ${mode.toString(8)})`)
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
const child = spawn(app.binary, [`--user-data-dir=${userData}`], {
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
