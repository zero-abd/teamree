// Boots the built app with the window hidden, asserts the renderer mounted and
// the preload bridge is reachable, then exits. Used by CI and by `npm run smoke`.
//
// Electron does not pump its event loop until this module finishes evaluating,
// so everything here hangs off callbacks rather than top-level await.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

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
}

app
  .whenReady()
  .then(run)
  .catch((error) => {
    failures.push(String(error))
  })
  .finally(finish)
