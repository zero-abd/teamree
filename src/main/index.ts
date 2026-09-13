import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { applicationMenuTemplate } from './appMenu'
import { APP_VERSION } from './appVersion'
import { startRuntime, type Runtime } from './runtime/startRuntime'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => {
    if (process.env.TEAMREE_BACKGROUND_LAUNCH !== '1') window.show()
  })

  // Keep external links in the user's browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return window
}

let runtime: Runtime | undefined
let stopping = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void app.whenReady().then(async () => {
    // Before any window: with no menu of its own Electron installs a default
    // one, whose File menu is a single "Close Window" on Cmd+W. A menu key
    // equivalent never reaches the web contents, so that one item is what the
    // renderer's "Close pane" binding has been losing to. See appMenu.ts.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(applicationMenuTemplate({ developing: process.env.ELECTRON_RENDERER_URL !== undefined }))
    )

    ipcMain.handle('teamree:select-project-folder', async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || event.senderFrame !== event.sender.mainFrame) return null
      const result = await dialog.showOpenDialog(owner, {
        title: 'Select project folder',
        properties: ['openDirectory'],
        buttonLabel: 'Select folder'
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })
    // The runtime comes up before any window so the first render can already
    // call it, and so the CLI endpoint exists as early as possible.
    try {
      runtime = await startRuntime({ userDataDir: app.getPath('userData'), version: APP_VERSION })
    } catch (error) {
      console.error('[runtime] failed to start', error)
    }

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Quitting waits for the runtime to release its socket and discovery file,
  // otherwise the next launch inherits a stale endpoint.
  app.on('before-quit', (event) => {
    if (!runtime || stopping) return
    stopping = true
    event.preventDefault()
    void runtime.stop().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
