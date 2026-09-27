// The guard as the main entry loads it, with Electron faked: Electron's own dialog is never the answer.

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeApp = EventEmitter & Record<'getPath' | 'whenReady' | 'relaunch' | 'quit', ReturnType<typeof vi.fn>>

const electron = vi.hoisted(() => ({
  app: undefined as unknown as FakeApp,
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(), showMessageBoxSync: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  ipcMain: { on: vi.fn() }
}))

vi.mock('electron', () => electron)

type Listener = (...args: unknown[]) => void
let userData: string
let installed: Map<string, Listener>

async function loadGuard(): Promise<typeof import('./index')> {
  vi.resetModules()
  installed = new Map()
  const on = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: Listener) => {
    installed.set(event, listener)
    return process
  }) as typeof process.on)
  try {
    return await import('./index')
  } finally {
    on.mockRestore()
  }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'teamree-crash-guard-'))
  electron.app = Object.assign(new EventEmitter(), {
    getPath: vi.fn(() => userData),
    whenReady: vi.fn(() => Promise.resolve()),
    relaunch: vi.fn(),
    quit: vi.fn()
  })
  for (const mock of [
    electron.dialog.showErrorBox,
    electron.dialog.showMessageBox,
    electron.dialog.showMessageBoxSync,
    electron.clipboard.writeText,
    electron.shell.showItemInFolder,
    electron.ipcMain.on
  ]) {
    mock.mockReset()
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  delete process.env.TEAMREE_BACKGROUND_LAUNCH
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userData, { recursive: true, force: true })
})

const logText = (): string => readFileSync(join(userData, 'logs', 'main-errors.log'), 'utf8')

describe('an uncaught error in the main process', () => {
  it('is written to the log and never reaches a dialog', async () => {
    await loadGuard()
    installed.get('uncaughtException')?.(new TypeError('Cannot read properties of undefined'))
    installed.get('unhandledRejection')?.(new Error('rejected'))
    expect(logText()).toContain('uncaught exception')
    expect(logText()).toContain('TypeError: Cannot read properties of undefined')
    expect(logText()).toContain('unhandled rejection')
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.dialog.showMessageBoxSync).not.toHaveBeenCalled()
  })

  it('reaches the window as details it can copy', async () => {
    const guard = await loadGuard()
    const send = vi.fn()
    guard.attachWindow(() => ({ isDestroyed: () => false, webContents: { send } }) as never)
    installed.get('uncaughtException')?.(new Error('boom'))
    expect(send).toHaveBeenCalledWith(guard.MAIN_ERROR_CHANNEL, expect.stringContaining('Error: boom'))
  })
})

describe('a launch that failed', () => {
  it('asks one terse question, copies the details, and restarts', async () => {
    const guard = await loadGuard()
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 })
    guard.mainErrors.launchFailed(new Error('the runtime did not start'))
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalled())

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    const options = electron.dialog.showMessageBox.mock.calls[0]?.[0] as { message: string; buttons: string[] }
    expect(options.message).toBe('teamree hit an error and needs to restart')
    expect(options.buttons).toEqual(['Restart', 'Copy Details', 'Quit'])
    expect(electron.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('the runtime did not start'))
    expect(electron.app.relaunch).toHaveBeenCalledTimes(1)
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('quits without restarting on Quit', async () => {
    const guard = await loadGuard()
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 2 })
    guard.mainErrors.launchFailed(new Error('no window'))
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalled())
    expect(electron.app.relaunch).not.toHaveBeenCalled()
  })

  it('asks nothing in a background launch', async () => {
    process.env.TEAMREE_BACKGROUND_LAUNCH = '1'
    const guard = await loadGuard()
    guard.mainErrors.launchFailed(new Error('no window'))
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalled())
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })
})

describe('a window whose page process is gone', () => {
  function window(): { webContents: { reload: ReturnType<typeof vi.fn> }; isDestroyed: () => boolean } {
    return { webContents: { reload: vi.fn() }, isDestroyed: () => false }
  }

  it('offers a reload instead of a white window', async () => {
    const guard = await loadGuard()
    const shown = window()
    guard.watchGoneProcesses(() => shown as never)
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    electron.app.emit('render-process-gone', {}, shown.webContents, { reason: 'crashed', exitCode: 11 })
    await vi.waitFor(() => expect(shown.webContents.reload).toHaveBeenCalledTimes(1))
    const options = electron.dialog.showMessageBox.mock.calls[0]?.[1] as { buttons: string[] }
    expect(options.buttons).toEqual(['Reload', 'Quit'])
    expect(logText()).toContain('crashed')
  })

  it('leaves a clean exit and other pages alone', async () => {
    const guard = await loadGuard()
    const shown = window()
    guard.watchGoneProcesses(() => shown as never)
    electron.app.emit('render-process-gone', {}, shown.webContents, { reason: 'clean-exit', exitCode: 0 })
    electron.app.emit('render-process-gone', {}, { reload: vi.fn() }, { reason: 'crashed', exitCode: 11 })
    electron.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 9 })
    await Promise.resolve()
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(logText()).toContain('GPU')
  })
})

describe('Show Error Log', () => {
  it('reveals the log, making an empty one when there is none yet', async () => {
    const guard = await loadGuard()
    guard.showErrorLog()
    const file = join(userData, 'logs', 'main-errors.log')
    expect(existsSync(file)).toBe(true)
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(file)
  })
})

describe('an error the window reports', () => {
  it('is logged when it comes from the main frame, as a bounded string', async () => {
    const guard = await loadGuard()
    guard.installErrorReports()
    const [channel, listener] = electron.ipcMain.on.mock.calls[0] as [string, Listener]
    expect(channel).toBe(guard.ERROR_REPORT_CHANNEL)
    const frame = {}
    listener({ senderFrame: frame, sender: { mainFrame: frame } }, 'TypeError: x is undefined')
    listener({ senderFrame: {}, sender: { mainFrame: frame } }, 'from a subframe')
    listener({ senderFrame: frame, sender: { mainFrame: frame } }, { not: 'a string' })
    expect(logText()).toContain('TypeError: x is undefined')
    expect(logText()).not.toContain('from a subframe')
    expect(logText()).not.toContain('a string')
  })
})

describe('what the window just wrote to localStorage', () => {
  it('is put on disk when the window asks, not when Chromium next commits', async () => {
    const guard = await loadGuard()
    guard.installStorageFlush()
    const [channel, listener] = electron.ipcMain.on.mock.calls[0] as [string, Listener]
    expect(channel).toBe(guard.STORAGE_FLUSH_CHANNEL)
    const flushStorageData = vi.fn()
    listener({ sender: { session: { flushStorageData } } })
    expect(flushStorageData).toHaveBeenCalledTimes(1)
  })
})
