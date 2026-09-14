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
// The app is pointed at the throwaway user data directory the launcher named,
// before anything else happens. That is not tidiness: the runtime restores the
// last session's panes from there, so a smoke test that read a developer's
// workspace would spawn their agents, take the single-instance lock their
// running copy holds, and write to the file that copy is keeping.
//
// That directory does not exist when this starts, which is deliberate and is
// what lets the last check below mean anything: Electron creates it, so its
// permissions are the ones a first launch would produce rather than a temporary
// directory's. See `checkLocalBoundary`.
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
import { existsSync, readFileSync, statSync } from 'node:fs'
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
// Raised only while `checkRendererBoundary` is deliberately provoking the
// content security policy. Chromium reports a script it refused to run as a
// console *error*, and a refusal is what that check is asking for — so for the
// length of it the refusal is collected from the page's own
// `securitypolicyviolation` event and the console line it also produces is not
// counted as a fault. Nothing else in this file turns it on.
let provoking = false

const opened = new Promise((resolve) => {
  app.once('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' && !provoking) failures.push(`console error: ${event.message}`)
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

  await checkRendererBoundary(window, ask)
  await checkPeerCrypto()
  checkLocalBoundary()
}

/**
 * What the window does with bytes it did not write.
 *
 * Every line of `docs/renderer-boundary.md` rests on four settings and one
 * refusal, and none of them can be read off the source with any confidence: a
 * `webPreferences` is a request, what the window ended up with is a fact, and
 * the two are only the same until somebody adds a second window or a default
 * changes under the app. So they are read back off the running window.
 *
 * Two of the three settings turn out to pin themselves, which was worth finding
 * out rather than assuming. Turning the sandbox on breaks the preload outright —
 * it is an ES module and a sandboxed preload is a classic script — and turning
 * `contextIsolation` off makes `contextBridge` refuse to run at all; this
 * harness already fails on a preload that will not load, so neither can be done
 * quietly. `nodeIntegration` is the one that can: with context isolation still
 * on, turning it on injects nothing the page can see, the bridge is still there,
 * the runtime still answers, and every check below this one but the first would
 * pass. That is the setting this reads back.
 *
 * The navigation check is the one that found something. A navigated-to document
 * keeps this window's preload — which is the whole runtime, the same catalogue
 * `docs/local-access.md` describes — and brings no policy of its own, because
 * the app's is a `<meta>` tag in the app's own HTML. That was watched happening
 * before `will-navigate` existed: the window went to a file written seconds
 * earlier and `window.teamree.runtime.call('status.get')` answered from it.
 */
async function checkRendererBoundary(window, ask) {
  const prefs = window.webContents.getLastWebPreferences() ?? {}
  const expected = { contextIsolation: true, nodeIntegration: false, sandbox: false }
  for (const [setting, want] of Object.entries(expected)) {
    if (prefs[setting] !== want) failures.push(`webPreferences.${setting} is ${prefs[setting]}, expected ${want}`)
  }

  // The consequence of the two above, rather than a restatement of them: with
  // context isolation on and node integration off there is no Node in the page
  // at all, which is what makes the bridge the only way out of it.
  const nodeInThePage = JSON.parse(
    await ask('JSON.stringify([typeof require, typeof process, typeof module, typeof Buffer])')
  )
  if (nodeInThePage.some((seen) => seen !== 'undefined')) {
    failures.push(`the renderer can see Node: require/process/module/Buffer are ${nodeInThePage.join(', ')}`)
  }

  // The policy in index.html, enforced rather than merely present. `script-src`
  // is not set there, so this is `default-src 'self'` doing the work — which is
  // the half of a meta policy worth checking, because a meta policy is also the
  // half that a navigation leaves behind.
  provoking = true
  const refusal = await ask(
    'new Promise((resolve) => {' +
      'document.addEventListener("securitypolicyviolation", (event) => resolve(event.effectiveDirective), { once: true });' +
      'const script = document.createElement("script");' +
      'script.textContent = "window.__smokeInlineRan = true";' +
      'document.head.appendChild(script);' +
      'setTimeout(() => resolve("the inline script was not refused"), 1000)' +
      '})'
  )
  const inlineRan = await ask('Boolean(window.__smokeInlineRan)')
  provoking = false
  if (refusal !== 'script-src-elem') failures.push(`an inline script in the renderer was answered with ${refusal}`)
  if (inlineRan) failures.push('an inline script ran in the renderer, so the content security policy is not enforced')

  // And the refusal the document is mostly about. A page that could navigate
  // could replace itself with anything and keep the bridge.
  const onTheApp = window.webContents.getURL()
  const elsewhere = pathToFileURL(join(root, 'package.json')).href
  await ask(`(() => { location.href = ${JSON.stringify(elsewhere)}; return "asked" })()`)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const landed = window.webContents.getURL()
  if (landed !== onTheApp) failures.push(`the renderer navigated the window to ${landed}`)
  if (failures.length === 0) {
    console.log('smoke: renderer has no Node, refuses an inline script, and cannot navigate the window')
  }
}

/**
 * Who on this machine can drive the runtime this launch started.
 *
 * The CLI socket serves the whole catalogue — create and remove worktrees,
 * spawn terminals, read any pane and type into it — so what stands in front of
 * it is two permissions and nothing else, and both of them are only ever real
 * in a running app. `docs/local-access.md` is the argument; this is the place
 * where it is checked against a Mac rather than against a unit test's tmpdir.
 *
 * The directory is the half this project does not set. Electron creates the
 * user data directory 0700 and every unit test that could assert it has a
 * `mkdtemp` directory, which is 0700 whatever anybody intended — so this is the
 * only check in the repository where a failure would mean something. If it ever
 * goes red, the enclosing directory is being made by something other than
 * Electron (every `mkdir` in this repository would leave 0755) and the local
 * model is wrong rather than merely undocumented.
 */
function checkLocalBoundary() {
  const mode = (path) => statSync(path).mode & 0o777
  const octal = (value) => `0${value.toString(8).padStart(3, '0')}`

  const dirMode = mode(userDataDir)
  if (dirMode !== 0o700) failures.push(`user data directory is ${octal(dirMode)}, expected 0700`)

  const discoveryPath = join(userDataDir, 'runtime.json')
  if (!existsSync(discoveryPath)) {
    failures.push('the runtime wrote no runtime.json, so the CLI has no way to find it')
    return
  }
  // Followed rather than assumed: `resolveEndpoint` puts the socket beside this
  // file, but falls back to a shared directory when the path would not fit in
  // sun_path, and the point of the mode below is that case.
  const { endpoint } = JSON.parse(readFileSync(discoveryPath, 'utf8'))
  if (!existsSync(endpoint)) {
    failures.push(`runtime.json names ${endpoint}, which does not exist`)
    return
  }
  const endpointMode = mode(endpoint)
  // ENDPOINT_MODE in src/main/runtime/socketServer.ts, spelled out because this
  // file is plain JavaScript in an Electron main process and imports no TypeScript.
  if (endpointMode !== 0o600) failures.push(`CLI socket is ${octal(endpointMode)}, expected 0600`)
  if (failures.length === 0) {
    console.log(`smoke: user data directory ${octal(dirMode)}, CLI socket ${octal(endpointMode)}`)
  }
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
