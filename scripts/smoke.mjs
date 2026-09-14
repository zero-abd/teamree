// Boots the built app with the window hidden, asserts the renderer mounted, the
// preload bridge is reachable and the runtime behind it answers, then exits. Run
// by `npm run smoke`, which is one of the gates `npm run release` refuses to
// publish without.
//
// It boots the real main process — `out/main/index.js`, the file the packaged
// app starts — rather than opening a window of its own onto the renderer. It
// used to do the latter, and the difference mattered: nothing in this process
// installed the IPC bridge, so every call the renderer made on mount was
// answered by Electron with "No handler registered for 'teamree:rpc:call'", the
// window put up "Could not reach the runtime", and the smoke test called that a
// pass. It asserted that a renderer can mount, which it can do with nothing
// behind it at all. Booting the real main process is also the only way the
// assembly in startRuntime.ts is ever exercised outside a unit test.
//
// The app is pointed at the throwaway user data directory the launcher made,
// before anything else happens. That is not tidiness: the runtime restores the
// last session's panes from there, so a smoke test that read a developer's
// workspace would spawn their agents, take the single-instance lock their
// running copy holds, and write to the file that copy is keeping.
//
// It also runs the peer library's cipher check here, in a genuine Electron main
// process, which is the process the teamwork feature's handshakes actually
// happen in. `src/shared/peer/electronRuntime.test.ts` runs the same check under
// every `npm test` with `ELECTRON_RUN_AS_NODE=1`, which is the same binary and
// the same BoringSSL but not the same process type — and the whole reason this
// check exists is that a runtime difference nobody had exercised took the
// feature out of every shipped build. So it is exercised in both.
//
// Electron does not pump its event loop until this module finishes evaluating,
// so everything here hangs off callbacks rather than top-level await.
import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPeerCheck } from './electron-peer-check.mjs'
import { PEER_BUNDLE_FLAG, USER_DATA_FLAG, readNamedArg } from './smoke-args.mjs'

const TIMEOUT_MS = 30_000
const READY_MS = 15_000
const root = process.cwd()
const failures = []

const bail = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS}ms`)
  process.exit(1)
}, TIMEOUT_MS)

// Both of these are settled before the app's own module body runs, which is why
// the import of it is deferred rather than written at the top of this file: the
// first is read while Electron is still deciding whether this process is a
// second instance, and the second while the window is deciding whether to show
// itself.
//
// A run with no directory to point at stops here rather than continuing into
// the real one. Refusing is the whole safeguard: the alternative is a gate that
// reads the workspace of whoever ran it, restores their panes, and spawns the
// agents in them.
const userDataDir = readNamedArg(USER_DATA_FLAG)
if (!userDataDir) {
  console.error('smoke: no user data directory was passed; run this through scripts/run-smoke.mjs')
  process.exit(1)
}
app.setPath('userData', userDataDir)
// The app shows its window as soon as it can paint unless this says otherwise.
// A gate has no business taking focus from whoever is running it; the packaged
// app check sets the same variable for the same reason. Set here rather than by
// the launcher so it holds however this script was started.
process.env.TEAMREE_BACKGROUND_LAUNCH = '1'

// Without this, closing the hidden window would quit before assertions finish.
app.on('window-all-closed', () => {})

// Attached at construction: the app loads the renderer into the window in the
// same breath as it creates it, and a listener added after that would miss
// whatever the first load had to say.
const opened = new Promise((resolve) => {
  app.once('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') failures.push(`console error: ${event.message}`)
    })
    window.webContents.on('did-fail-load', (_loadEvent, code, description) => {
      failures.push(`did-fail-load ${code} ${description}`)
    })
    window.webContents.on('preload-error', (_preloadEvent, path, error) => {
      failures.push(`preload-error ${path} ${error.message}`)
    })
    resolve(window)
  })
})

function finish() {
  clearTimeout(bail)
  if (failures.length) {
    for (const failure of failures) console.error(`smoke: ${failure}`)
    app.exit(1)
  } else {
    console.log('smoke: renderer mounted, preload bridge reachable, runtime answering')
    app.exit(0)
  }
}

/** Polls `probe` until it is true, and records `failure` if it never is. */
async function waitFor(probe, failure) {
  const deadline = Date.now() + READY_MS
  for (;;) {
    if (await probe()) return true
    if (Date.now() >= deadline) {
      failures.push(failure)
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function run() {
  // After `whenReady`, which is safe — a `whenReady` asked for later resolves
  // just the same — and which is what lets the two settings above be made
  // before the app reads them.
  await import(pathToFileURL(join(root, 'out/main/index.js')).href)

  const window = await opened
  if (window.webContents.isLoading()) {
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  }

  const ask = (expression) => window.webContents.executeJavaScript(expression)

  await waitFor(
    () => ask('Boolean(document.querySelector("#root")?.childElementCount)'),
    'renderer did not mount into #root'
  )
  await waitFor(
    () => ask('typeof window.teamree?.versions?.electron === "string"'),
    'preload bridge is not exposed on window.teamree'
  )
  // The assertion the old harness could not make: a call placed by the renderer,
  // over the bridge the product uses, answered by the runtime this launch
  // started. Anything less proves only that a window can open.
  await waitFor(
    () => ask('window.teamree.runtime.call("status.get", {}).then((response) => response.ok === true, () => false)'),
    'the runtime did not answer a call from the renderer'
  )

  await checkPeerCrypto()
}

/**
 * The peer library, in this process. `run-smoke.mjs` compiled it and named the
 * directory on the command line; without one, say so rather than quietly
 * checking nothing, because a check that can skip itself is how the cipher
 * defect survived 1803 passing tests.
 */
async function checkPeerCrypto() {
  const bundle = readNamedArg(PEER_BUNDLE_FLAG)
  if (!bundle) {
    failures.push('no peer bundle was passed; run this through scripts/run-smoke.mjs')
    return
  }
  const result = await runPeerCheck(bundle)
  for (const failure of result.failures) failures.push(`peer crypto: ${failure}`)
  if (result.nativeChaCha) {
    // Not a failure — but it means this run proved less than it looks like it
    // did, and the reader should know which runtime actually answered.
    console.log(`smoke: note — ${result.runtime} has a native chacha20-poly1305, which Electron 38 did not`)
  }
  if (result.failures.length === 0) {
    console.log(`smoke: peer handshake and published Noise vectors pass under ${result.runtime}`)
  }
}

app
  .whenReady()
  .then(run)
  .catch((error) => {
    failures.push(String(error))
  })
  .finally(finish)
