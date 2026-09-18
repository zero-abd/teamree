// Runs the runtime as its own process for the acceptance suite. It must be a
// separate process: the suite drives the CLI synchronously, which would block
// the event loop the runtime needs in order to answer.
import { join } from 'node:path'
import { startRuntime } from '../src/main/runtime/startRuntime.ts'

const userDataDir = process.env.TEAMREE_USER_DATA_DIR

const runtime = await startRuntime({
  userDataDir,
  // Under the harness's own directory, not the person's home.
  //
  // Every caller of this file hands it a freshly made temporary `userDataDir`
  // and deletes that directory when it is done — so putting the checkouts
  // inside it is what makes one of these runtimes a thing that can be run twice
  // at once. Left at the default, two harnesses on one machine share
  // `~/.teamree/worktrees/<project>`: each picks the first free checkout name
  // it can see, both pick the same one, and the one that loses `git worktree
  // add` goes on to read a path that another run has since taken or removed.
  // That is a failure of the harness and it arrives looking like a failure of
  // git, so it is worth not having. It also stops every run leaving a checkout
  // behind in the user's home.
  worktreesRoot: join(userDataDir, 'worktrees'),
  version: process.env.TEAMREE_TEST_VERSION ?? '0.0.0-acceptance',
  serveRenderer: false,
  // The suite has no business asking GitHub anything, and a check firing in the
  // middle of it would be a network call inside a test that never asked for one.
  checkForUpdates: false,
  onError: (error) => console.error('RUNTIME_ERROR', error?.message ?? error)
})

console.log(`READY ${runtime.endpoint}`)

// Guarded, because there are now four ways in and they can overlap: a SIGTERM
// while stdin is closing is one shutdown, not two, and `runtime.stop()` is not
// written to be called twice.
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await runtime.stop()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

// The other way this process learns it should go: whoever started it holds the
// write end of this stdin, so the pipe closing means they are gone.
//
// It matters because it is the only signal that survives their death. A harness
// waiting for an ordered shutdown cannot send anything once it has itself been
// killed — which is what vitest does to a worker whose hook ran out of time —
// and a runtime left behind at that moment is not merely a stray process: it
// holds a socket, a discovery file the next run would believe, and a tree of
// ptys. That risk is what used to force the harness to hold a stopwatch over a
// shutdown and kill it when the time was up, and the stopwatch was wrong on any
// machine with work on it. With this, the harness can wait for the shutdown it
// actually wants and nothing is orphaned by its own patience.
process.stdin.on('end', () => void stop())
process.stdin.on('close', () => void stop())
process.stdin.resume()

// Keeps the process alive; the suite ends it with SIGTERM, or by going away.
setInterval(() => {}, 1 << 30)
