// Runs the runtime as its own process for the acceptance suite. It must be a
// separate process: the suite drives the CLI synchronously, which would block
// the event loop the runtime needs in order to answer.
import { join } from 'node:path'
import { startRuntime } from '../src/main/runtime/startRuntime.ts'

const userDataDir = process.env.TEAMREE_USER_DATA_DIR

const runtime = await startRuntime({
  userDataDir,
  // Checkouts under the harness's temp dir, not `~/.teamree/worktrees`: two harnesses sharing it pick the
  // same free name and one loses `git worktree add`, which looks like a git failure.
  worktreesRoot: join(userDataDir, 'worktrees'),
  version: process.env.TEAMREE_TEST_VERSION ?? '0.0.0-acceptance',
  serveRenderer: false,
  // No update check: a network call inside tests that never asked for one.
  checkForUpdates: false,
  onError: (error) => console.error('RUNTIME_ERROR', error?.message ?? error)
})

console.log(`READY ${runtime.endpoint}`)

// Guarded: four ways in can overlap, and `runtime.stop()` is not safe to call twice.
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await runtime.stop()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

// Stdin closing means the parent is gone. It is the only signal that survives vitest killing a worker,
// and without it a runtime would be left holding a socket, a discovery file and ptys.
process.stdin.on('end', () => void stop())
process.stdin.on('close', () => void stop())
process.stdin.resume()

// Keeps the process alive; the suite ends it with SIGTERM, or by going away.
setInterval(() => {}, 1 << 30)
