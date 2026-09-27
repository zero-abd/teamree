// Imported first by the main entry, so no error thrown while the rest loads reaches Electron's raw
// "A JavaScript error occurred in the main process" dialog. See mainErrors.ts for what happens instead.

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainEvent } from 'electron'
import { APP_VERSION } from '../appVersion'
import { isBackgroundLaunch } from '../launchProfile'
import { createMainErrors, ERROR_LOG_NAME } from './mainErrors'

/** Main to window: one error's details, for Copy Details. */
export const MAIN_ERROR_CHANNEL = 'teamree:errors:main'
/** Window to main: an error the window caught or nothing did, for the log. */
export const ERROR_REPORT_CHANNEL = 'teamree:errors:report'

export const mainErrors = createMainErrors({
  logFile: () => join(app.getPath('userData'), 'logs', ERROR_LOG_NAME),
  version: APP_VERSION,
  print: (entry) => console.error(entry.trimEnd()),
  offerRestart: (details) => void offerRestart(details)
})

// Electron shows its dialog only while its own listener is the sole one.
process.on('uncaughtException', (error) => mainErrors.caught('uncaught exception', error))
process.on('unhandledRejection', (reason) => mainErrors.caught('unhandled rejection', reason))

async function offerRestart(details: string): Promise<void> {
  if (isBackgroundLaunch(process.env)) {
    app.quit()
    return
  }
  await app.whenReady()
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'teamree hit an error and needs to restart',
      buttons: ['Restart', 'Copy Details', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    if (response === 1) {
      clipboard.writeText(details)
      continue
    }
    if (response === 0) app.relaunch()
    app.quit()
    return
  }
}

/** Sends each error the window should hear of to whichever window is open. */
export function attachWindow(window: () => BrowserWindow | undefined): void {
  mainErrors.attach((details) => {
    const shown = window()
    if (shown !== undefined && !shown.isDestroyed()) shown.webContents.send(MAIN_ERROR_CHANNEL, details)
  })
}

/** A crashed window page is offered a reload; any other gone process is logged. */
export function watchGoneProcesses(window: () => BrowserWindow | undefined): void {
  let asking = false
  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return
    mainErrors.log('window process gone', `${details.reason} (exit ${details.exitCode})`)
    const shown = window()
    if (shown === undefined || shown.isDestroyed() || shown.webContents !== contents || asking) return
    if (isBackgroundLaunch(process.env)) return void contents.reload()
    asking = true
    void dialog
      .showMessageBox(shown, {
        type: 'warning',
        message: 'The window crashed',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        asking = false
        if (response === 0) contents.reload()
        else app.quit()
      })
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    mainErrors.log('child process gone', `${details.type} ${details.reason} (exit ${details.exitCode})`)
  })
}

/** Help → Show Error Log; an empty file when nothing has gone wrong yet. */
export function showErrorLog(): void {
  const file = mainErrors.logFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    closeSync(openSync(file, 'a'))
  } catch (error) {
    mainErrors.log('show error log', error)
  }
  shell.showItemInFolder(file)
}

/** Logs what the window's main frame reports; its own boundaries already said so on screen. */
export function installErrorReports(): void {
  ipcMain.on(ERROR_REPORT_CHANNEL, (event: IpcMainEvent, details: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof details !== 'string') return
    mainErrors.log('window error', details)
  })
}
