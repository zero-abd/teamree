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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import { electronSandboxArgs } from './electron-sandbox.mjs'
import { buildPeerBundle } from './peer-bundle.mjs'
import { PEER_BUNDLE_FLAG, USER_DATA_FLAG, namedArg } from './smoke-args.mjs'
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

const plan = displayPlan(electron, [
  ...electronSandboxArgs(),
  'scripts/smoke.mjs',
  namedArg(PEER_BUNDLE_FLAG, peerBundle),
  namedArg(USER_DATA_FLAG, userDataDir)
])
if (plan.note) console.log(`run-smoke: ${plan.note}`)
if (plan.advice) console.error(`run-smoke: ${plan.advice}`)

const result = spawnSync(plan.command, plan.args, { stdio: 'inherit' })

rmSync(peerBundle, { recursive: true, force: true })
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
