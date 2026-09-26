// The menu bar extra wired to Electron and the runtime: the status item, its setting and the Quick
// Note panel. Everything it decides is in the modules beside it; this file only connects them.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray, type NativeImage } from 'electron'
import { resolvePalette } from '../../shared/theme'
import type { AgentNoticeChannel } from '../agentNotices'
import { windowBackground } from '../nativeAppearance'
import type { Runtime } from '../runtime/startRuntime'
import type { MenuBarAction, MenuBarState } from './model'
import { noteCheckout, quickNoteContext, saveQuickNote, type QuickNote } from './quickNote'
import { installQuickNote, QUICK_NOTE_SIZE, quickNotePlacement } from './quickNoteWindow'
import { followMenuBarSetting } from './setting'
import { createStatusItem, dotBitmap, menuTemplate } from './statusItem'

export type MenuBarExtraHost = {
  runtime: Runtime
  notices: AgentNoticeChannel | undefined
  /** Fronts the window, opening one when there is none. */
  openWindow: () => void
  /** Chooses one of the window's own commands, opening a window first when needed. */
  runCommand: (command: string) => void
  quit: () => void
  preload: string
  /** A background launch shows no window, this panel included. */
  background: boolean
}

/** Beside `out/` in a checkout and in the package's asar alike; see `files` in electron-builder.yml. */
const IMAGES = join(import.meta.dirname, '../../resources/menu-bar')

/** A template image from its @1x and @2x files; read through fs, which reaches into the asar. */
function template(name: string): NativeImage {
  const image = nativeImage.createFromBuffer(readFileSync(join(IMAGES, `${name}.png`)), { scaleFactor: 1 })
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(join(IMAGES, `${name}@2x.png`)) })
  image.setTemplateImage(true)
  return image
}

/** The asking colour of the app's palette, as a menu item's 8pt dot. */
function askingDot(runtime: Runtime): NativeImage {
  const tone = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const color = resolvePalette(runtime.context.store.getAppearance(), tone).warning
  return nativeImage.createFromBitmap(dotBitmap(16, color), { width: 16, height: 16, scaleFactor: 2 })
}

export function installMenuBarExtra(host: MenuBarExtraHost): () => void {
  const { runtime } = host
  const store = runtime.context.store
  const images = { idle: template('teamreeTemplate'), asking: template('teamreeAskingTemplate') }

  const state = (): MenuBarState => ({
    worktrees: store.listProjects().flatMap((project) => store.listWorktrees(project.id)),
    terminals: runtime.terminals(),
    paneNames: host.notices?.window()?.names ?? {},
    update: runtime.updateState()
  })

  const run = (action: MenuBarAction): void => {
    switch (action.kind) {
      case 'reveal':
        host.openWindow()
        host.notices?.revealPane({ worktreeId: action.worktreeId, terminalId: action.terminalId })
        return
      case 'open':
        return host.openWindow()
      case 'new-task':
        return host.runCommand('new-worktree')
      case 'settings':
        return host.runCommand('open-settings')
      case 'quick-note':
        return quickNote.open()
      case 'check-updates':
        host.openWindow()
        void runtime.checkForUpdates().catch((error: unknown) => console.warn('[updates]', error))
        return
      case 'restart':
        void runtime.restartToUpdate().catch((error: unknown) => console.warn('[updates]', error))
        return
      case 'quit':
        return host.quit()
    }
  }

  const statusItem = createStatusItem({
    createTray: (image: NativeImage) => new Tray(image),
    image: (kind) => images[kind],
    menu: (entries) => Menu.buildFromTemplate(menuTemplate(entries, run, askingDot(runtime))),
    state,
    defer: (apply) => void setImmediate(apply)
  })

  const quickNote = installQuickNote(ipcMain, {
    create: () => {
      const anchor = statusItem.bounds()
      const display = anchor === null ? screen.getPrimaryDisplay() : screen.getDisplayMatching(anchor)
      const panel = new BrowserWindow({
        ...QUICK_NOTE_SIZE,
        ...quickNotePlacement(anchor, display.workArea),
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // A non-activating panel takes the keys without bringing the app's other windows forward.
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        backgroundColor: windowBackground(store.getAppearance(), nativeTheme),
        webPreferences: { preload: host.preload, sandbox: false, contextIsolation: true, nodeIntegration: false }
      })
      panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      panel.webContents.on('will-navigate', (event) => event.preventDefault())
      panel.once('ready-to-show', () => {
        if (host.background || panel.isDestroyed()) return
        panel.show()
        panel.focus()
      })
      const devServerUrl = process.env.ELECTRON_RENDERER_URL
      if (devServerUrl) void panel.loadURL(`${devServerUrl}/quick-note.html`)
      else void panel.loadFile(join(import.meta.dirname, '../renderer/quick-note.html'))
      return panel
    },
    context: () =>
      quickNoteContext({
        projects: store.listProjects(),
        worktrees: store.listWorktrees(),
        lastProjectId: store.quickNoteProject(),
        activeWorktreeId: host.notices?.window()?.activeWorktreeId ?? null
      }),
    save: async (note: QuickNote) => {
      const project = store.getProject(note.projectId)
      if (project === undefined) throw new Error('That project is gone.')
      const worktree = note.worktreeId === null ? undefined : store.getWorktree(note.worktreeId)
      const saved = await saveQuickNote({ checkout: noteCheckout(project, worktree), text: note.text, at: new Date() })
      store.setQuickNoteProject(project.id)
      runtime.context.workspaceEvents.emit({ type: 'worktrees' })
      return saved
    }
  })

  const stopSetting = followMenuBarSetting({
    shown: () => store.runtimeSettings().showInMenuBar,
    events: runtime.context.workspaceEvents,
    statusItem
  })

  const stopEvents = runtime.context.workspaceEvents.on((event) => {
    if (['terminals', 'worktrees', 'projects', 'updates'].includes(event.type)) statusItem.refresh()
  })
  return () => {
    stopEvents()
    stopSetting()
    quickNote.stop()
    statusItem.show(false)
  }
}
