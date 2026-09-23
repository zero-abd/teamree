// Launches scripts/smoke.mjs under Electron with the switches and display this machine needs, after
// building the peer bundle and the throwaway profile in plain Node, which outlives the Electron run.
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
// A path inside the temp dir, so Electron creates it and the check reads Electron's permissions, not mkdtemp's.
const smokeRoot = mkdtempSync(join(tmpdir(), 'teamree-smoke-'))
const userDataDir = join(smokeRoot, 'teamree')

// Built out here so a fixture failure does not read as a broken window. `-c`, not `git config`, so
// nothing touches the runner's config; the commit gives the worktree a branch to start from.
const fixtureRepo = join(smokeRoot, 'repo')
mkdirSync(fixtureRepo, { recursive: true })
const fixtureGit = ['-c', 'user.email=smoke@teamree.invalid', '-c', 'user.name=smoke', '-c', 'commit.gpgsign=false']
// A committed file, so a diff has context lines and both gutters mean something; `.ts` for the tokenizer.
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
    // Not fatal: the window-level checks do not need it.
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

// Worktrees under the throwaway root, not `~/.teamree/worktrees/smoke/` where the real app lists them.
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
