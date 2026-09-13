// Launches scripts/smoke.mjs under Electron.
//
// It is a separate launcher rather than part of the npm script because the
// arguments Electron needs depend on the machine (see electron-sandbox.mjs),
// and because the smoke script itself runs as the Electron main process and so
// cannot choose its own command line.
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import { electronSandboxArgs } from './electron-sandbox.mjs'

const result = spawnSync(electron, [...electronSandboxArgs(), 'scripts/smoke.mjs'], { stdio: 'inherit' })

if (result.error) {
  console.error(`run-smoke: could not launch Electron: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  console.error(`run-smoke: Electron was killed by ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
