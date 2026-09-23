// Launches scripts/smoke.mjs under Electron.
//
// It is a separate launcher rather than part of the npm script because how
// Electron has to be started depends on the machine — which switches it needs
// (see electron-sandbox.mjs) and whether it has a display to open a window on
// (see virtual-display.mjs) — and because the smoke script itself runs as the
// Electron main process and so cannot choose its own command line.
//
// It also compiles `src/shared/peer` on the way in and hands the smoke test the
// result, and makes the throwaway user data directory the app is to run
// against. Both are here rather than in `smoke.mjs` for the same reason as
// everything else in this file: they want plain Node and a process that is
// still around afterwards to clean up, and `smoke.mjs` is an Electron main
// process that has exited by then.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import { electronSandboxArgs } from './electron-sandbox.mjs'
import { buildPeerBundle } from './peer-bundle.mjs'
import { FIXTURE_REPO_FLAG, PEER_BUNDLE_FLAG, USER_DATA_FLAG, namedArg } from './smoke-args.mjs'
import { displayPlan } from './virtual-display.mjs'

const peerBundle = await buildPeerBundle()
// A path inside a throwaway directory rather than the throwaway directory
// itself, so that the one the app runs against does not exist yet and Electron
// has to create it. That is the difference between a smoke run that asserts the
// permissions of `mkdtemp` — which are 0700 by definition and prove nothing —
// and one that asserts the permissions Electron gives the user data directory,
// which is what everything in `docs/local-access.md` rests on.
const smokeRoot = mkdtempSync(join(tmpdir(), 'teamree-smoke-'))
const userDataDir = join(smokeRoot, 'teamree')

// A repository for the window to open, so the checks that need a worktree have
// one. Three synchronous calls, and deliberately outside the Electron process:
// a fixture that failed to build in there would be reported as the window being
// broken, which is the opposite of what these checks are for.
//
// `-c` rather than `git config`, so nothing is read from or written to whoever
// is running this. A commit needs an identity and an empty repository has no
// branch to create a worktree from, hence the commit.
const fixtureRepo = join(smokeRoot, 'repo')
mkdirSync(fixtureRepo, { recursive: true })
const fixtureGit = ['-c', 'user.email=smoke@teamree.invalid', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false']
// A committed file, so that a worktree made from this has something to *change*
// rather than only something to add. The difference matters to exactly one
// check: a patch over an untracked file is additions from line one, and the
// numbers in a diff's two gutters are only worth asserting where the two sides
// disagree — which needs context lines, which needs a file that was there
// before. Named `.ts` so the tokenizer has a table for it.
writeFileSync(join(fixtureRepo, 'note.ts'), 'const one = 1\nconst two = 2\nconst three = 3\n')
const fixtureSteps = [
  ['init', '-b', 'main'],
  ['add', 'note.ts'],
  [...fixtureGit, 'commit', '-m', 'initial']
]
let fixture = fixtureRepo
for (const args of fixtureSteps) {
  const step = spawnSync('git', args, { cwd: fixtureRepo, encoding: 'utf8' })
  if (step.status !== 0) {
    // Not fatal. The window-level checks do not need it, and a machine without
    // a usable git should be told which checks it lost rather than handed a
    // failure that looks like the app.
    console.error(`run-smoke: no fixture repository (git ${args[0]} failed), so worktree checks are skipped`)
    fixture = ''
    break
  }
}

const plan = displayPlan(electron, [
  ...electronSandboxArgs(),
  'scripts/smoke.mjs',
  namedArg(PEER_BUNDLE_FLAG, peerBundle),
  namedArg(USER_DATA_FLAG, userDataDir),
  ...(fixture === '' ? [] : [namedArg(FIXTURE_REPO_FLAG, fixture)])
])
if (plan.note) console.log(`run-smoke: ${plan.note}`)
if (plan.advice) console.error(`run-smoke: ${plan.advice}`)

// The checkouts the worktree checks make go under the same throwaway root as
// the profile, and are gone with it. Without this every run left one behind in
// `~/.teamree/worktrees/smoke/`, in the folder the real app lists.
const result = spawnSync(plan.command, plan.args, {
  stdio: 'inherit',
  env: { ...process.env, TEAMREE_WORKTREES_ROOT: join(smokeRoot, 'worktrees') }
})

rmSync(peerBundle, { recursive: true, force: true })
rmSync(smokeRoot, { recursive: true, force: true })
rmSync(smokeRoot, { recursive: true, force: true })

if (result.error) {
  console.error(`run-smoke: could not launch Electron: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  console.error(`run-smoke: Electron was killed by ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
