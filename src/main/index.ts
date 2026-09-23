import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuOptions } from './appMenu'
import { installMenuBar } from './menuBar'
import { DEFAULT_APPEARANCE, resolvePalette } from '../shared/theme'
import { TRAFFIC_LIGHT_X_PX, TRAFFIC_LIGHT_Y_PX } from '../shared/windowChrome'
import { APP_VERSION } from './appVersion'
import { createQuitSequence } from './quitSequence'
import { registerRevealHandler } from './reveal/revealPath'
import { startRuntime, type Runtime } from './runtime/startRuntime'
import { mayOpenExternally, navigationVerdict } from './windowNavigation'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // macOS hides the title bar but keeps drawing the window buttons over our
    // content, so they are placed against the strip the renderer draws. Setting
    // this overrides hiddenInset's default x as well as its y, which is why both
    // numbers and the renderer's matching inset come from one shared module.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: TRAFFIC_LIGHT_X_PX, y: TRAFFIC_LIGHT_Y_PX } }
      : {}),
    // The ground the chosen theme is about to paint, so the frame Electron
    // shows before the renderer has rendered anything is already the right
    // colour. Hard-coding one meant that switching to a dark theme still opened
    // on a flash of the old near-black, and switching to a light one opened on
    // a flash of dark.
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // Off because the preload is an ES module, not because anything in it
      // wants Node. A sandboxed preload is evaluated as a classic script, so
      // `out/preload/index.mjs` fails to load with "Cannot use import statement
      // outside a module" and the window comes up with no bridge at all — which
      // is what happens when this line is flipped, watched rather than guessed:
      // `npm run smoke` reports the `preload-error` and goes red. What the
      // preload actually touches — `contextBridge`, `ipcRenderer`,
      // `process.platform`, `process.versions` — a sandboxed preload has.
      //
      // It is not free. This renderer runs outside Chromium's own sandbox, so a
      // defect in the code that draws somebody else's pane is a defect with the
      // user's account behind it rather than one behind a second wall. Turning
      // it on means emitting the preload as CommonJS first; `docs/renderer-boundary.md`
      // has the whole of it.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => {
    if (process.env.TEAMREE_BACKGROUND_LAUNCH !== '1') window.show()
  })

  // Keep external links in the user's browser, never in an app window — and
  // never hand macOS anything that is not a web address. See windowNavigation.ts
  // for what that is worth today, which is honestly not much.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (mayOpenExternally(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // And the same answer for a navigation, which `setWindowOpenHandler` never
  // sees. The window carries the preload bridge onto whatever it lands on, so
  // the only page allowed in it is the one it already has.
  window.webContents.on('will-navigate', (event, url) => {
    const verdict = navigationVerdict(window.webContents.getURL(), url)
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict === 'external') void shell.openExternal(url)
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return window
}

/**
 * The window's backdrop, from the appearance this installation last chose.
 *
 * Falls back to the default theme's ground whenever the runtime is not up yet
 * or could not read its file — which is the same ground `tokens.css` declares,
 * so the fallback is not a guess.
 */
function windowBackground(): string {
  return resolvePalette(runtime?.context.store.getAppearance() ?? DEFAULT_APPEARANCE)['bg-window']
}

let runtime: Runtime | undefined

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  // The launch, from `whenReady` to the first window, as one promise — because
  // a quit arriving in the middle of it has to wait for it. Between
  // `restoreSessions()` and `startRuntime` resolving there are panes running
  // that nothing can kill yet, and `quitSequence.ts` makes that argument in
  // full. Its own failures are logged here rather than left to reject, so that
  // a launch nobody is waiting on is never an unhandled rejection.
  const launched = app.whenReady().then(async () => {
    // Before any window: with no menu of its own Electron installs a default
    // one, whose File menu is a single "Close Window" on Cmd+W. A menu key
    // equivalent never reaches the web contents, so that one item is what the
    // renderer's "Close pane" binding has been losing to. See appMenu.ts.
    //
    // Installed empty of teamree's own commands and then again for real once
    // the window has said what they are and which of them are live. That gap is
    // a fraction of a second of a menu bar with the platform's roles and
    // nothing else, which is what this app had until now; the alternative is a
    // bar built from a guess about a window that has not rendered.
    const installMenu = (commands?: ApplicationMenuOptions['commands']): void => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          applicationMenuTemplate({
            developing: process.env.ELECTRON_RENDERER_URL !== undefined,
            // Reads `runtime` when it is clicked rather than capturing it now:
            // the menu is installed before the runtime starts, on purpose, and a
            // click in the second before it is up does nothing rather than
            // throwing. The answer reaches the window over the workspace stream,
            // which is why nothing here touches a BrowserWindow.
            checkForUpdates: () => {
              void runtime?.checkForUpdates().catch((error: unknown) => console.warn('[updates]', error))
            },
            commands
          })
        )
      )
    }
    installMenu()

    // And the window's own menus, rebuilt whenever its answer changes. What
    // arrives is checked before it is drawn and the choice goes back to the
    // frame that published it; see src/main/menuBar.ts for both.
    installMenuBar(ipcMain, {
      install: (items, choose) => installMenu({ items, choose }),
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })

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
    // "Reveal in Finder", which is the window's own action and not a fact about
    // the workspace, so it rides this bridge rather than the runtime contract —
    // the CLI has no file manager and a teammate across the relay must never be
    // able to open a window here. Everything that can go wrong comes back as a
    // reason to show, because `shell.showItemInFolder` on a path that is gone
    // does nothing at all and says nothing about it; see src/main/reveal.
    registerRevealHandler(ipcMain, {
      showItemInFolder: (target) => shell.showItemInFolder(target),
      // The same guard the folder picker above makes: a subframe is not the
      // window, and must not be able to drive the user's file manager.
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })
    // The runtime comes up before any window so the first render can already
    // call it, and so the CLI endpoint exists as early as possible.
    try {
      runtime = await startRuntime({
        userDataDir: app.getPath('userData'),
        version: APP_VERSION,
        // The one way this process opens a browser, handed over explicitly so
        // that the update check's download link is the only thing that can.
        openExternal: (url) => shell.openExternal(url)
      })
    } catch (error) {
      console.error('[runtime] failed to start', error)
    }

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  // Nothing awaits `launched` unless a quit arrives while it is in flight,
  // which is to say almost never. Without this line a launch that threw would
  // be an unhandled rejection in the main process rather than a line in the
  // log, on a run where nobody pressed anything.
  void launched.catch((error: unknown) => console.error('[launch]', error))

  // Quitting waits for the runtime to release its socket and discovery file,
  // otherwise the next launch inherits a stale endpoint — and to write down
  // what every pane printed, which is the last thing the teardown does and so
  // the first thing an interrupted one loses. Every quit is held back until
  // that has finished, including the second ⌘Q from somebody who read the pause
  // as a key that did nothing; `quitSequence.ts` argues it in full.
  //
  // A quit that arrives before the launch is done waits for the launch first.
  // `runtime` being undefined is not the same as nothing being started: by then
  // `restoreSessions()` has spawned a pty for every pane of the last session,
  // and the handle that can kill them is what this is waiting for.
  const onBeforeQuit = createQuitSequence({
    whenStarted: () => launched,
    stop: () => runtime?.stop() ?? Promise.resolve(),
    quit: () => app.quit()
  })
  app.on('before-quit', onBeforeQuit)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
