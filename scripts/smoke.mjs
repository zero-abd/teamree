// Boots the built app with the window hidden, asserts the renderer mounted and
// the preload bridge is reachable, then exits. Run by `npm run smoke`, which is
// one of the gates `npm run release` refuses to publish without.
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
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { runPeerCheck } from './electron-peer-check.mjs'

const TIMEOUT_MS = 30_000
const root = process.cwd()
const failures = []

const bail = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS}ms`)
  process.exit(1)
}, TIMEOUT_MS)

// Without this, closing the hidden window would quit before assertions finish.
app.on('window-all-closed', () => {})

function finish() {
  clearTimeout(bail)
  if (failures.length) {
    for (const failure of failures) console.error(`smoke: ${failure}`)
    app.exit(1)
  } else {
    console.log('smoke: renderer mounted, preload bridge reachable')
    app.exit(0)
  }
}

async function run() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(root, 'out/preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') failures.push(`console error: ${event.message}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    failures.push(`did-fail-load ${code} ${description}`)
  })
  window.webContents.on('preload-error', (_event, path, error) => {
    failures.push(`preload-error ${path} ${error.message}`)
  })

  await window.loadFile(join(root, 'out/renderer/index.html'))
  await new Promise((resolve) => setTimeout(resolve, 500))

  const mounted = await window.webContents.executeJavaScript(
    'Boolean(document.querySelector("#root")?.childElementCount)'
  )
  const bridged = await window.webContents.executeJavaScript('typeof window.teamree?.versions?.electron === "string"')

  if (!mounted) failures.push('renderer did not mount into #root')
  if (!bridged) failures.push('preload bridge is not exposed on window.teamree')

  await checkPeerCrypto()
}

/**
 * The peer library, in this process. `run-smoke.mjs` compiled it and named the
 * directory on the command line; without one, say so rather than quietly
 * checking nothing, because a check that can skip itself is how the cipher
 * defect survived 1803 passing tests.
 */
async function checkPeerCrypto() {
  const bundle = process.argv[2]
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
