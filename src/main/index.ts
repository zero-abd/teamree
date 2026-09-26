import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { installAgentNotices, type AgentNoticeChannel } from './agentNotices'
import { aboutPanelOptions, applicationMenuTemplate, offersDevTools, type ApplicationMenuOptions } from './appMenu'
import { FILE_SCHEME, FILE_SCHEME_PRIVILEGES, fileGrants, serveGrantedFile } from './files/fileProtocol'
import { installKeepAwake } from './keepAwake'
import { INVITATION_OPEN_CHANNEL, installInvitationLinks, invitationInArgv } from './invitationLinks'
import {
  frontsExistingWindow,
  isBackgroundLaunch,
  launchData,
  leaveKeychainAlone,
  userDataOverride
} from './launchProfile'
import { bringForward, revealLaunchWindow, watchActivation } from './launchReveal'
import { installMenuBar } from './menuBar'
import { installMenuBarExtra } from './menuBarExtra'
import { createCommandRelay } from './menuBarExtra/commandRelay'
import { DEFAULT_APPEARANCE, type Appearance } from '../shared/theme'
import { installNativeAppearance, windowBackground } from './nativeAppearance'
import { TRAFFIC_LIGHT_X_PX, TRAFFIC_LIGHT_Y_PX } from '../shared/windowChrome'
import { APP_VERSION } from './appVersion'
import { createQuitSequence } from './quitSequence'
import { installUnsavedFiles, type UnsavedFiles } from './unsavedFiles'
import { registerOpenPathHandler } from './reveal/openPath'
import { registerRevealHandler } from './reveal/revealPath'
import { startRuntime, type Runtime } from './runtime/startRuntime'
import { bundleOf, SelfInstaller } from './updates'
import { optOutOfStateRestoration } from './stateRestoration'
import { mayOpenExternally, navigationVerdict, windowOpenAnswer } from './windowNavigation'
import {
  loadWindowState,
  minimumSize,
  placeWindow,
  saveWindowState,
  trackWindowState,
  WINDOW_STATE_FILE
} from './windowState'

const PRELOAD = join(import.meta.dirname, '../preload/index.mjs')

function createWindow(): BrowserWindow {
  const stateFile = join(app.getPath('userData'), WINDOW_STATE_FILE)
  const primary = screen.getPrimaryDisplay().workArea
  const opened = placeWindow(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
    primary
  )
  const window = new BrowserWindow({
    ...opened.bounds,
    ...minimumSize(primary),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Setting this overrides hiddenInset's default x as well as y, so both
    // numbers and the renderer's matching inset come from one shared module.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: TRAFFIC_LIGHT_X_PX, y: TRAFFIC_LIGHT_Y_PX } }
      : {}),
    // The chosen theme's ground, or the first frame flashes the wrong colour.
    backgroundColor: windowBackground(currentAppearance(), nativeTheme),
    webPreferences: {
      preload: PRELOAD,
      // Off because the preload is an ES module: a sandboxed preload is
      // evaluated as a classic script and fails with "Cannot use import
      // statement outside a module". See `docs/renderer-boundary.md` for the cost.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  trackWindowState(window, opened, (state) => saveWindowState(stateFile, state))
  appWindow = window

  // The red button asks about edited files as ⌘Q does; a quit already asked.
  let mayClose = false
  window.on('close', (event) => {
    if (mayClose || leaving || unsaved === undefined || unsaved.paths().length === 0) return
    event.preventDefault()
    void unsaved.ask('close').then((proceed) => {
      if (!proceed || window.isDestroyed()) return
      mayClose = true
      window.close()
    })
  })

  window.on('ready-to-show', () => {
    // Both modes show a hidden window, so a background launch applies neither.
    if (isBackgroundLaunch(process.env)) return
    revealLaunchWindow(window, opened, { platform: process.platform, activated, app })
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

/** A packaged Mac app replaces itself in place; anything else offers the `.dmg`. */
function selfInstall(): { selfInstall?: SelfInstaller } {
  const bundle = process.platform === 'darwin' && app.isPackaged ? bundleOf(app.getPath('exe')) : null
  if (bundle === null) return {}
  return {
    selfInstall: new SelfInstaller({ bundlePath: bundle, stagingRoot: join(app.getPath('userData'), 'updates') })
  }
}

function currentAppearance(): Appearance {
  return runtime?.context.store.getAppearance() ?? DEFAULT_APPEARANCE
}

let runtime: Runtime | undefined
let followAppearance: ((appearance: Appearance) => void) | undefined
let notices: AgentNoticeChannel | undefined
let unsaved: UnsavedFiles | undefined
/** Set once a quit is past its questions, so closing the window asks nothing more. */
let leaving = false
/** `teamree quit --force`: the edits stay in the profile as drafts. */
let forced = false

/** Quits past the Save question; the window's edits stay in the profile as drafts. */
function quitWithoutAsking(): void {
  forced = true
  unsaved?.release()
  app.quit()
}

/** The app's window, not the Quick Note panel; undefined once closed. */
let appWindow: BrowserWindow | undefined

/** The window, for the handful of things that act on whichever one is open. */
function mainWindow(): BrowserWindow | undefined {
  return appWindow === undefined || appWindow.isDestroyed() ? undefined : appWindow
}

/** Fronts the window for something the person asked for in the menu bar, opening one when there is none. */
function openWindow(): void {
  const background = isBackgroundLaunch(process.env)
  const existing = mainWindow()
  // Activated first, so a new window's `ready-to-show` reveals it as a launch macOS fronted.
  if (!background) app.focus({ steal: true })
  if (existing === undefined) createWindow()
  else if (!background) bringForward(existing)
}

/** Menu bar commands such as New Task…, chosen once a window has published them. */
const windowCommands = createCommandRelay()

/** Puts a number on the dock icon; `app.dock` is undefined off macOS. */
function setDockBadge(count: number): void {
  app.dock?.setBadge(count === 0 ? '' : String(count))
}

// Before the lock: Chromium keys the single-instance lock on the profile, so a
// throwaway profile runs beside the installed app instead of knocking on it.
const profile = userDataOverride(process.env, process.cwd())
if (profile) app.setPath('userData', profile)
for (const name of leaveKeychainAlone(process.env)) app.commandLine.appendSwitch(name)

// At module load: AppKit consults it when the launch event arrives, before `ready`.
optOutOfStateRestoration(process.platform, systemPreferences)

// At module load: macOS activates a launch it fronts just after `ready`, long before the window can show.
const activated = watchActivation(app)

// Before `ready`, or Chromium will not stream or range-request the scheme. The smoke run
// imports this module after `ready`, where the call throws; there media just loads unprivileged.
if (!app.isReady()) protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: FILE_SCHEME_PRIVILEGES }])

if (!app.requestSingleInstanceLock(launchData(process.env))) {
  app.quit()
} else {
  // Registered before `ready`: macOS delivers the link that launched the app as the launch finishes.
  const invitations = installInvitationLinks(ipcMain, {
    send: (link) => {
      const window = mainWindow()
      if (!window) return false
      window.webContents.send(INVITATION_OPEN_CHANNEL, link)
      bringForward(window)
      return true
    },
    fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    invitations.receive(url)
  })
  const launchLink = invitationInArgv(process.argv)
  if (launchLink !== undefined) invitations.receive(launchLink)

  app.on('second-instance', (_event, argv, _cwd, knocking) => {
    const link = invitationInArgv(argv)
    if (link !== undefined) return invitations.receive(link)
    const existing = mainWindow()
    if (!existing || !frontsExistingWindow(process.env, knocking)) return
    bringForward(existing)
  })

  // The launch as one promise, because a quit arriving mid-way has to wait for
  // it: between `restoreSessions()` and `startRuntime` resolving there are
  // panes running that nothing can kill yet. See `quitSequence.ts`.
  const launched = app.whenReady().then(async () => {
    // Electron turns these into a graceful quit, which would wait on a question nobody is there to
    // answer. After `ready`, because Electron installs its own handlers just before it.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, quitWithoutAsking)
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
        const notification = new Notification({
          title: spec.title,
          ...(spec.subtitle === undefined ? {} : { subtitle: spec.subtitle }),
          body: spec.body,
          silent: spec.silent,
          ...(spec.actions === undefined
            ? {}
            : { actions: spec.actions.map((action) => ({ type: 'button' as const, text: action.label })) })
        })
        notification.on('click', spec.onActivate)
        notification.on('action', (_event, index) => spec.actions?.[index]?.run())
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
    app.on('browser-window-focus', () => {
      notices?.noteWindowFocus()
      runtime?.noteWindowFocus()
    })
    app.on('browser-window-blur', () => runtime?.noteWindowBlur())

    // The window's own menus, rebuilt whenever its answer changes; see src/main/menuBar.ts.
    installMenuBar(ipcMain, {
      install: (items, choose) => {
        installMenu({ items, choose })
        windowCommands.published(items, choose)
      },
      fromMainFrame: (event) => event.senderFrame === event.sender.mainFrame
    })

    unsaved = installUnsavedFiles(ipcMain, {
      setEdited: (sender, edited) => {
        if (process.platform === 'darwin') BrowserWindow.fromWebContents(sender)?.setDocumentEdited(edited)
      },
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
    ipcMain.handle('teamree:choose-folder', async (event, defaultPath: unknown) => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || event.senderFrame !== event.sender.mainFrame) return null
      const result = await dialog.showOpenDialog(owner, {
        title: 'Choose Folder',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Choose',
        ...(typeof defaultPath === 'string' ? { defaultPath } : {})
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
        ...selfInstall(),
        trashItem: (path) => shell.trashItem(path),
        onAgentNotice: (notice) => notices?.deliver(notice),
        onSharedNote: (note) => notices?.announce({ title: `${note.handle} shared a note`, body: note.title }),
        // `teamree quit`: only `app.quit` runs `before-quit`. See quitSequence.ts.
        requestQuit: (force) => (force ? quitWithoutAsking() : app.quit()),
        unsavedFiles: () => unsaved?.paths() ?? [],
        onAppearance: (appearance) => followAppearance?.(appearance),
        systemTone: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
        fetchBases: true,
        online: () => net.isOnline()
      })
    } catch (error) {
      console.error('[runtime] failed to start', error)
    }

    followAppearance = installNativeAppearance({
      nativeTheme,
      appearance: currentAppearance,
      windows: () => BrowserWindow.getAllWindows()
    })
    createWindow()
    app.on('activate', () => {
      if (mainWindow() === undefined) createWindow()
    })
    // macOS only: the app already outlives its last window there, and the status item is how it is reached.
    if (runtime && process.platform === 'darwin') {
      installMenuBarExtra({
        runtime,
        notices,
        openWindow,
        runCommand: (command) => {
          openWindow()
          windowCommands.run(command)
        },
        quit: () => app.quit(),
        preload: PRELOAD,
        background: isBackgroundLaunch(process.env)
      })
    }
  })
  // Almost nothing awaits `launched`; without this a failed launch is an unhandled rejection.
  void launched.catch((error: unknown) => console.error('[launch]', error))

  // Quitting waits for the runtime to release its socket and write every pane's
  // output, and for the launch first if that is still in flight: `runtime`
  // being undefined does not mean no ptys were spawned. See `quitSequence.ts`.
  const onBeforeQuit = createQuitSequence({
    whenStarted: () => launched,
    mayQuit: async () => {
      const proceed = forced || unsaved === undefined || (await unsaved.ask('quit'))
      if (!proceed) runtime?.quitDeclined()
      return proceed
    },
    stop: () => {
      leaving = true
      return runtime?.stop() ?? Promise.resolve()
    },
    quit: () => app.quit()
  })
  app.on('before-quit', onBeforeQuit)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
