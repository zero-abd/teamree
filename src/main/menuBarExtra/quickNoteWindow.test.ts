import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  installQuickNote,
  QUICK_NOTE_CLOSE_CHANNEL,
  QUICK_NOTE_CONTEXT_CHANNEL,
  QUICK_NOTE_SAVE_CHANNEL,
  QUICK_NOTE_SIZE,
  quickNotePlacement,
  type QuickNotePanel
} from './quickNoteWindow'

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 }

describe('quickNotePlacement', () => {
  it('sits under the status item, centred on it', () => {
    const at = quickNotePlacement({ x: 1000, y: 0, width: 24, height: 24 }, WORK_AREA)
    expect(at).toEqual({ x: 1012 - QUICK_NOTE_SIZE.width / 2, y: 31 })
  })

  it('stays on the display when the item is at its edge', () => {
    const at = quickNotePlacement({ x: 1430, y: 0, width: 24, height: 24 }, WORK_AREA)
    expect(at.x).toBe(1440 - 8 - QUICK_NOTE_SIZE.width)
  })

  it('takes the top right of the work area with no item to sit under', () => {
    expect(quickNotePlacement(null, WORK_AREA)).toEqual({ x: 1440 - 8 - QUICK_NOTE_SIZE.width, y: 31 })
  })
})

function fakeIpc() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (event: IpcMainEvent) => void>()
  const ipc = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: (channel: string, listener: (event: IpcMainEvent) => void) => listeners.set(channel, listener),
    removeAllListeners: (channel: string) => listeners.delete(channel)
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeAllListeners'>
  return {
    ipc,
    invoke: (channel: string, sender: unknown, ...args: unknown[]) =>
      handlers.get(channel)?.({ sender } as IpcMainInvokeEvent, ...args),
    send: (channel: string, sender: unknown) => listeners.get(channel)?.({ sender } as IpcMainEvent),
    count: () => handlers.size + listeners.size
  }
}

function harness(save: (note: unknown) => Promise<string> = async () => '/repo/NOTES.md') {
  const log: string[] = []
  const panels: (QuickNotePanel & { webContents: object; gone: boolean })[] = []
  const bridge = fakeIpc()
  const quickNote = installQuickNote(bridge.ipc, {
    create: () => {
      const panel = {
        webContents: {},
        gone: false,
        isDestroyed: () => panel.gone,
        show: () => log.push('show'),
        focus: () => log.push('focus'),
        close: () => {
          log.push('close')
          panel.gone = true
        }
      }
      panels.push(panel)
      log.push('create')
      return panel
    },
    context: () => ({ projects: [{ id: 'p1', name: 'teamree' }], projectId: 'p1', worktree: null }),
    save
  })
  return { log, panels, bridge, quickNote }
}

describe('installQuickNote', () => {
  it('creates one panel however often it is opened, and a new one after it closed', () => {
    const { log, panels, quickNote } = harness()
    quickNote.open()
    quickNote.open()
    panels[0]?.close()
    quickNote.open()
    expect(log).toEqual(['create', 'show', 'focus', 'close', 'create'])
  })

  it('answers the panel and nobody else', async () => {
    const { bridge, panels, quickNote } = harness()
    quickNote.open()
    expect(await bridge.invoke(QUICK_NOTE_CONTEXT_CHANNEL, {})).toBeNull()
    expect(await bridge.invoke(QUICK_NOTE_CONTEXT_CHANNEL, panels[0]?.webContents)).toMatchObject({ projectId: 'p1' })
    expect(await bridge.invoke(QUICK_NOTE_SAVE_CHANNEL, {}, { projectId: 'p1', worktreeId: null, text: 'x' })).toEqual({
      problem: 'Not from the Quick Note panel.'
    })
  })

  it('saves a note, then closes the panel', async () => {
    const saved: unknown[] = []
    const { bridge, panels, quickNote, log } = harness(async (note) => {
      saved.push(note)
      return '/repo/NOTES.md'
    })
    quickNote.open()
    const note = { projectId: 'p1', worktreeId: null, text: 'ship it' }
    expect(await bridge.invoke(QUICK_NOTE_SAVE_CHANNEL, panels[0]?.webContents, note)).toEqual({
      saved: '/repo/NOTES.md'
    })
    expect(saved).toEqual([note])
    expect(log.at(-1)).toBe('close')
  })

  it('keeps the panel open and says why when a note cannot be saved', async () => {
    const { bridge, panels, quickNote, log } = harness(async () => {
      throw new Error('"NOTES.md" changed on disk')
    })
    quickNote.open()
    const webContents = panels[0]?.webContents
    expect(
      await bridge.invoke(QUICK_NOTE_SAVE_CHANNEL, webContents, { projectId: 'p1', worktreeId: null, text: 'a' })
    ).toEqual({
      problem: '"NOTES.md" changed on disk'
    })
    expect(await bridge.invoke(QUICK_NOTE_SAVE_CHANNEL, webContents, { projectId: 'p1', text: '' })).toEqual({
      problem: 'Nothing to save.'
    })
    expect(log.at(-1)).not.toBe('close')
  })

  it('closes on the panel’s own Esc only, and takes its handlers away when stopped', () => {
    const { bridge, panels, quickNote, log } = harness()
    quickNote.open()
    bridge.send(QUICK_NOTE_CLOSE_CHANNEL, {})
    expect(log).toEqual(['create'])
    bridge.send(QUICK_NOTE_CLOSE_CHANNEL, panels[0]?.webContents)
    expect(log.at(-1)).toBe('close')
    quickNote.stop()
    expect(bridge.count()).toBe(0)
  })
})
