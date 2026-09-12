// Runs the runtime as its own process for the acceptance suite. It must be a
// separate process: the suite drives the CLI synchronously, which would block
// the event loop the runtime needs in order to answer.
import { startRuntime } from '../src/main/runtime/startRuntime.ts'

const runtime = await startRuntime({
  userDataDir: process.env.TEAMREE_USER_DATA_DIR,
  version: process.env.TEAMREE_TEST_VERSION ?? '0.0.0-acceptance',
  serveRenderer: false,
  onError: (error) => console.error('RUNTIME_ERROR', error?.message ?? error)
})

console.log(`READY ${runtime.endpoint}`)

const stop = async () => {
  await runtime.stop()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

// Keeps the process alive; the suite ends it with SIGTERM.
setInterval(() => {}, 1 << 30)
