// Launches scripts/smoke.mjs under Electron.
//
// It is a separate launcher rather than part of the npm script because the
// arguments Electron needs depend on the machine (see electron-sandbox.mjs),
// and because the smoke script itself runs as the Electron main process and so
// cannot choose its own command line.
//
// It also compiles `src/shared/peer` on the way in and hands the smoke test the
// result. That is here rather than in `smoke.mjs` for the same reason as
// everything else in this file: the bundling needs plain Node and a working
// directory, and `smoke.mjs` is already running as an Electron main process by
// the time it could ask.
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import { electronSandboxArgs } from './electron-sandbox.mjs'
import { buildPeerBundle } from './peer-bundle.mjs'

const peerBundle = await buildPeerBundle()

const result = spawnSync(electron, [...electronSandboxArgs(), 'scripts/smoke.mjs', peerBundle], {
  stdio: 'inherit'
})

rmSync(peerBundle, { recursive: true, force: true })

if (result.error) {
  console.error(`run-smoke: could not launch Electron: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  console.error(`run-smoke: Electron was killed by ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
