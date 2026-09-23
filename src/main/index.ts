import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerSaveBlocker,
  protocol,
  screen,
  shell
} from 'electron'
import { installAgentNotices, type AgentNoticeChannel } from './agentNotices'
import { aboutPanelOptions, applicationMenuTemplate, offersDevTools, type ApplicationMenuOptions } from './appMenu'
import { FILE_SCHEME, FILE_SCHEME_PRIVILEGES, fileGrants, serveGrantedFile } from './files/fileProtocol'
import { installKeepAwake } from './keepAwake'
import { frontsExistingWindow, isBackgroundLaunch, launchData, userDataOverride } from './launchProfile'
import { installMenuBar } from './menuBar'
import { DEFAULT_APPEARANCE, resolvePalette } from '../shared/theme'
import { TRAFFIC_LIGHT_X_PX, TRAFFIC_LIGHT_Y_PX } from '../shared/windowChrome'
import { APP_VERSION } from './appVersion'
import { createQuitSequence } from './quitSequence'
import { registerOpenPathHandler } from './reveal/openPath'
import { registerRevealHandler } from './reveal/revealPath'
import { startRuntime, type Runtime } from './runtime/startRuntime'
import { mayOpenExternally, navigationVerdict, windowOpenAnswer } from './windowNavigation'
import { loadWindowState, placeWindow, saveWindowState, trackWindowState, WINDOW_STATE_FILE } from './windowState'

function createWindow(): BrowserWindow {
  const stateFile = join(app.getPath('userData'), WINDOW_STATE_FILE)
  const opened = placeWindow(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea
  )
  const window = new BrowserWindow({
    ...opened.bounds,
    minWidth: 800,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Setting this overrides hiddenInset's default x as well as y, so both
    // numbers and the renderer's matching inset come from one shared module.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: TRAFFIC_LIGHT_X_PX, y: TRAFFIC_LIGHT_Y_PX } }
      : {}),
    // The chosen theme's ground, or the first frame flashes the wrong colour.
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // Off because the preload is an ES module: a sandboxed preload is
      // evaluated as a classic script and fails with "Cannot use import
      // statement outside a module". See `docs/renderer-boundary.md` for the cost.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  trackWindowState(window, opened, (state) => saveWindowState(stateFile, state))

  window.on('ready-to-show', () => {
    // Both modes show a hidden window, so a background launch applies neither.
    if (isBackgroundLaunch(process.env)) return
    if (opened.maximized) window.maximize()
    window.show()
    if (opened.fullScreen) window.setFullScreen(true)
  })

  // A link in a pane arrives here via `window.open`; windowNavigation.ts decides.
  window.webContents.setWindowOpenHandler(({ url }) =>
    windowOpenAnswer(url, (target) => void shell.openExternal(target))
  )

  // The window carries the preload bridge onto whatever it lands on, so the
  // only page allowed in it is the one it already has.
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

/** The window's backdrop from the last chosen appearance; the default is the same ground `tokens.css` declares. */
function windowBackground(): string {
  return resolvePalette(runtime?.context.store.getAppearance() ?? DEFAULT_APPEARANCE)['bg-window']
}

let runtime: Runtime | undefined
let notices: AgentNoticeChannel | undefined

/** The window, for the handful of things that act on whichever one is open. */
function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

/** Puts a number on the dock icon; `app.dock` is undefined off macOS. */
function setDockBadge(count: number): void {
  app.dock?.setBadge(count === 0 ? '' : String(count))
}

// Before the lock: Chromium keys the single-instance lock on the profile, so a
// throwaway profile runs beside the installed app instead of knocking on it.
const profile = userDataOverride(process.env, process.cwd())
if (profile) app.setPath('userData', profile)

// Before `ready`, or Chromium will not stream or range-request the scheme. The smoke run
// imports this module after `ready`, where the call throws; there media just loads unprivileged.
if (!app.isReady()) protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: FILE_SCHEME_PRIVILEGES }])

if (!app.requestSingleInstanceLock(launchData(process.env))) {
  app.quit()
} else {
  app.on('second-instance', (_event, _argv, _cwd, knocking) => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing || !frontsExistingWindow(process.env, knocking)) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  // The launch as one promise, because a quit arriving mid-way has to wait for
  // it: between `restoreSessions()` and `startRuntime` resolving there are
  // panes running that nothing can kill yet. See `quitSequence.ts`.
  const launched = app.whenReady().then(async () => {
    // Before any window, or Electron's default menu binds Cmd+W to Close
    // Window ahead of the renderer (see appMenu.ts). Installed again once the
    // window has published its commands.
    const installMenu = (commands?: ApplicationMenuOptions['commands']): void => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          applicationMenuTemplate({
            developing: process.env.ELECTRON_RENDERER_URL !== undefined,
            devTools: offersDevTools(process.env),
            links: {
              version: APP_VERSION,
              systemVersion: process.getSystemVersion(),
              open: (url) => {
                if (mayOpenExternally(url)) void shell.openExternal(url)
              }
            },
            // Reads `runtime` at click time: the menu is installed before it starts.
            checkForUpdates: () => {
              void runtime?.checkForUpdates().catch((error: unknown) => console.warn('[updates]', error))
            },
            commands
          })
        )
      )
    }
    installMenu()
    protocol.handle(FILE_SCHEME, (request) => serveGrantedFile(fileGrants, request))

    // Packaged, macOS draws the bundle's icon in About; unpackaged it would be Electron's.
    const icon = app.isPackaged ? undefined : join(import.meta.dirname, '../../build/icon.png')
    if (icon !== undefined) app.dock?.setIcon(icon)
    app.setAboutPanelOptions(aboutPanelOptions(APP_VERSION, icon))

    // Before the runtime: `startRuntime` restores the last session's panes,
    // and one of them can settle in that same breath.
    notices = installAgentNotices(ipcMain, {
      windowFocused: () => mainWindow()?.isFocused() ?? false,
      show: (spec) => {
        if (!Notification.isSupported()) return
        const notification = new Notification({ title: spec.title, body: spec.body, silent: spec.silent })
        notification.on('click', spec.onActivate)
        notification.show()
      },
      setBadge: setDockBadge,
      focusWindow: () => {
        const window = mainWindow()
        if (!window) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      },
      // A subframe is not the window and does not speak for it.
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })
    app.on('browser-window-focus', () => notices?.noteWindowFocus())

    // The window's own menus, rebuilt whenever its answer changes; see src/main/menuBar.ts.
    installMenuBar(ipcMain, {
      install: (items, choose) => installMenu({ items, choose }),
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })

    // Whether this Mac may sleep, as the window decides it; see src/main/keepAwake.ts.
    installKeepAwake(ipcMain, {
      blocker: powerSaveBlocker,
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
    // "Reveal in Finder" rides this bridge, not the runtime contract: a teammate
    // across the relay must never open a window here. See src/main/reveal.
    registerRevealHandler(ipcMain, {
      showItemInFolder: (target) => shell.showItemInFolder(target),
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })
    registerOpenPathHandler(ipcMain, {
      openPath: (target) => shell.openPath(target),
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })
    // Before any window, so the first render can already call it.
    try {
      runtime = await startRuntime({
        userDataDir: app.getPath('userData'),
        version: APP_VERSION,
        // `~/.teamree/worktrees` is outside `--user-data-dir`, so a gate run
        // against a throwaway profile still wrote checkouts into the real one.
        // The gates set this; nothing in the product reads it.
        ...(process.env.TEAMREE_WORKTREES_ROOT === undefined
          ? {}
          : { worktreesRoot: process.env.TEAMREE_WORKTREES_ROOT }),
        openExternal: (url) => shell.openExternal(url),
        downloadsDirectory: app.getPath('downloads'),
        openPath: (path) => shell.openPath(path),
        trashItem: (path) => shell.trashItem(path),
        onAgentNotice: (notice) => notices?.deliver(notice),
        // `teamree quit`: only `app.quit` runs `before-quit`. See quitSequence.ts.
        requestQuit: () => app.quit()
      })
    } catch (error) {
      console.error('[runtime] failed to start', error)
    }

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  // Almost nothing awaits `launched`; without this a failed launch is an unhandled rejection.
  void launched.catch((error: unknown) => console.error('[launch]', error))

  // Quitting waits for the runtime to release its socket and write every pane's
  // output, and for the launch first if that is still in flight: `runtime`
  // being undefined does not mean no ptys were spawned. See `quitSequence.ts`.
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
