// The Quick Note panel's main-process end: one panel at a time, placed under the status item,
// and IPC that answers that panel alone. Electron's window is made by the caller.

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { readQuickNote, type QuickNote, type QuickNoteContext } from './quickNote'

/** Keep in step with `src/preload/index.ts`, which repeats the literals. */
export const QUICK_NOTE_CONTEXT_CHANNEL = 'teamree:quick-note:context'
export const QUICK_NOTE_SAVE_CHANNEL = 'teamree:quick-note:save'
export const QUICK_NOTE_CLOSE_CHANNEL = 'teamree:quick-note:close'

export const QUICK_NOTE_SIZE = { width: 440, height: 236 } as const

/** Space kept between the panel and the menu bar or the display's edge. */
const MARGIN_PX = 6
const EDGE_PX = 8

type Rect = { x: number; y: number; width: number; height: number }

/** Under the status item and centred on it, kept on its display; the top right without one. */
export function quickNotePlacement(anchor: Rect | null, workArea: Rect): { x: number; y: number } {
  const right = workArea.x + workArea.width - EDGE_PX - QUICK_NOTE_SIZE.width
  const y = Math.max(workArea.y, anchor === null ? 0 : anchor.y + anchor.height) + MARGIN_PX
  if (anchor === null) return { x: right, y }
  const centred = Math.round(anchor.x + anchor.width / 2 - QUICK_NOTE_SIZE.width / 2)
  return { x: Math.max(workArea.x + EDGE_PX, Math.min(centred, right)), y }
}

/** The parts of a BrowserWindow this reads. */
export type QuickNotePanel = {
  webContents: unknown
  isDestroyed: () => boolean
  show: () => void
  focus: () => void
  close: () => void
}

export type QuickNoteSaved = { saved: string } | { problem: string }

export function installQuickNote(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeAllListeners'>,
  host: {
    /** A new panel, shown once it has painted. */
    create: () => QuickNotePanel
    context: () => QuickNoteContext
    /** Writes the note and answers where. */
    save: (note: QuickNote) => Promise<string>
  }
): { open: () => void; stop: () => void } {
  let panel: QuickNotePanel | null = null
  const live = (): QuickNotePanel | null => (panel === null || panel.isDestroyed() ? null : panel)
  const fromPanel = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const open = live()
    return open !== null && event.sender === open.webContents
  }

  ipc.handle(QUICK_NOTE_CONTEXT_CHANNEL, (event) => (fromPanel(event) ? host.context() : null))
  ipc.handle(QUICK_NOTE_SAVE_CHANNEL, async (event, payload: unknown): Promise<QuickNoteSaved> => {
    if (!fromPanel(event)) return { problem: 'Not from the Quick Note panel.' }
    const note = readQuickNote(payload)
    if (note === null) return { problem: 'Nothing to save.' }
    try {
      const saved = await host.save(note)
      live()?.close()
      return { saved }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) }
    }
  })
  ipc.on(QUICK_NOTE_CLOSE_CHANNEL, (event) => {
    if (fromPanel(event)) live()?.close()
  })

  return {
    open() {
      const open = live()
      if (open === null) {
        panel = host.create()
        return
      }
      open.show()
      open.focus()
    },
    stop() {
      ipc.removeHandler(QUICK_NOTE_CONTEXT_CHANNEL)
      ipc.removeHandler(QUICK_NOTE_SAVE_CHANNEL)
      ipc.removeAllListeners(QUICK_NOTE_CLOSE_CHANNEL)
    }
  }
}
