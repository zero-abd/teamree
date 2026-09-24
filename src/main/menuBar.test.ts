// What the main process will and will not draw in its menu bar: a message
// decides what goes into `Menu.buildFromTemplate`, so the parse is the boundary.
// No Electron; `ipcMain` and a web contents are faked.

import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainEvent } from 'electron'
import { installMenuBar, MENU_COMMAND_CHANNEL, MENU_PUBLISH_CHANNEL, readMenuBarItems } from './menuBar'

/** One well-formed item, which each case below spoils in exactly one way. */
const ITEM = {
  command: 'close-pane',
  label: 'Close Pane',
  accelerator: 'CommandOrControl+W',
  section: 'file',
  enabled: true
}

describe('reading a published menu', () => {
  it('takes a list of items and gives back exactly those fields', () => {
    expect(readMenuBarItems([ITEM])).toEqual([ITEM])
    expect(readMenuBarItems([])).toEqual([])
  })

  it('refuses anything that is not a list of items', () => {
    expect(readMenuBarItems(undefined)).toBeNull()
    expect(readMenuBarItems(null)).toBeNull()
    expect(readMenuBarItems('close-pane')).toBeNull()
    expect(readMenuBarItems({ items: [ITEM] })).toBeNull()
    expect(readMenuBarItems([null])).toBeNull()
  })

  it('refuses an item with a field missing or of the wrong kind', () => {
    for (const field of ['command', 'label', 'accelerator', 'section', 'enabled'] as const) {
      const { [field]: _dropped, ...rest } = ITEM
      expect(readMenuBarItems([rest]), `${field} missing`).toBeNull()
      expect(readMenuBarItems([{ ...ITEM, [field]: 7 }]), `${field} wrong kind`).toBeNull()
    }
    expect(readMenuBarItems([{ ...ITEM, label: '' }])).toBeNull()
    expect(readMenuBarItems([{ ...ITEM, command: '' }])).toBeNull()
  })

  // A key equivalent placed above Quit in the same menu wins the key.
  it('refuses an accelerator that is not shaped like one of the table’s chords', () => {
    for (const accelerator of [
      'CommandOrControl+Alt+Shift+D',
      'CommandOrControl+,',
      'CommandOrControl+Shift+D',
      // Electron spells an arrow `Up`; the worktree moves are on the arrows.
      'CommandOrControl+Alt+Up',
      'CommandOrControl+Alt+Down',
      'CommandOrControl+Shift+Enter',
      'CommandOrControl+1',
      'CommandOrControl+9',
      // The tab walk is Control on every platform.
      'Control+Tab',
      'Control+Shift+Tab',
      // And the file column's tabs, paged.
      'Control+PageDown',
      'Control+PageUp',
      // The region walk, on F6 alone.
      'F6',
      'Shift+F6',
      // No key at all claims nothing from the platform.
      ''
    ]) {
      expect(readMenuBarItems([{ ...ITEM, accelerator }]), accelerator).toEqual([{ ...ITEM, accelerator }])
    }
    for (const accelerator of [
      'Q',
      'Command+Q',
      'CommandOrControl+Shift+Alt+D',
      'CommandOrControl+Escape',
      'CommandOrControl+ ',
      'CommandOrControl+D+',
      // Named keys are the four arrows and Return, not "a word".
      'CommandOrControl+Tab',
      'CommandOrControl+F4',
      'CommandOrControl+Space',
      'CommandOrControl+UpDown',
      // Tab is Control's alone, and Control takes nothing else.
      'Control+D',
      'Control+Q',
      'Control+Alt+Tab',
      'Control+Shift+PageDown',
      // F6 is the one bare key, and takes only shift.
      'F5',
      'Alt+F6',
      'Control+F6',
      'Shift+F4'
    ]) {
      expect(readMenuBarItems([{ ...ITEM, accelerator }]), accelerator).toBeNull()
    }
  })

  // Quit, Hide and Minimize are the platform's; an item of ours above them would take the key.
  it('refuses the keys the platform’s own items answer', () => {
    for (const accelerator of ['CommandOrControl+Q', 'CommandOrControl+H', 'CommandOrControl+M']) {
      expect(readMenuBarItems([{ ...ITEM, accelerator }]), accelerator).toBeNull()
    }
    expect(readMenuBarItems([{ ...ITEM, accelerator: 'CommandOrControl+Shift+M' }])).toHaveLength(1)
  })

  it('refuses a list longer than any menu bar', () => {
    expect(readMenuBarItems(Array.from({ length: 64 }, () => ITEM))).toHaveLength(64)
    expect(readMenuBarItems(Array.from({ length: 65 }, () => ITEM))).toBeNull()
  })

  // Half a menu bar is worse than the one already installed.
  it('drops the whole list rather than the item it could not read', () => {
    expect(readMenuBarItems([ITEM, { ...ITEM, section: 4 }])).toBeNull()
  })

  // `Menu.buildFromTemplate` reads `click`, `role` and `submenu` off whatever it is handed.
  it('leaves behind anything else the sender put on an item', () => {
    const items = readMenuBarItems([{ ...ITEM, role: 'close', click: 'anything', submenu: [{ role: 'quit' }] }])
    expect(items).toEqual([ITEM])
    expect(items?.[0] && 'role' in items[0]).toBe(false)
  })
})

/** Just enough `ipcMain` to see who listened, and to deliver to them. */
function fakeIpc(): { ipc: IpcMain; publish: (event: unknown, payload: unknown) => void; listeners: number } {
  const listeners: ((event: IpcMainEvent, payload: unknown) => void)[] = []
  const ipc = {
    on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => {
      expect(channel).toBe(MENU_PUBLISH_CHANNEL)
      listeners.push(listener)
    },
    removeAllListeners: (channel: string) => {
      expect(channel).toBe(MENU_PUBLISH_CHANNEL)
      listeners.length = 0
    }
  } as unknown as IpcMain

  return {
    ipc,
    publish: (event, payload) => {
      for (const listener of [...listeners]) listener(event as IpcMainEvent, payload)
    },
    get listeners() {
      return listeners.length
    }
  }
}

/** A window's main frame, or — with `subframe` — something pretending to be. */
function sender(options: { subframe?: boolean; destroyed?: boolean } = {}): {
  event: unknown
  sent: { channel: string; command: string }[]
  /** What Electron does when the window goes: fires the `destroyed` listeners. */
  destroy: () => void
} {
  const sent: { channel: string; command: string }[] = []
  const onDestroyed: (() => void)[] = []
  const contents = {
    isDestroyed: () => options.destroyed === true,
    send: (channel: string, command: string) => sent.push({ channel, command }),
    once: (name: string, listener: () => void) => {
      expect(name).toBe('destroyed')
      onDestroyed.push(listener)
    },
    mainFrame: { name: 'main' }
  }
  return {
    event: { sender: contents, senderFrame: options.subframe === true ? { name: 'other' } : contents.mainFrame },
    sent,
    destroy: () => {
      for (const listener of onDestroyed.splice(0)) listener()
    }
  }
}

const fromMainFrame = (event: IpcMainEvent): boolean => event.senderFrame === event.sender.mainFrame

describe('the menu bar bridge', () => {
  it('installs the menu the window published', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    const window = sender()
    ipc.publish(window.event, [ITEM])
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[0]).toEqual([ITEM])
  })

  it('installs nothing at all when it could not read what arrived', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    ipc.publish(sender().event, { items: [ITEM] })
    expect(install).not.toHaveBeenCalled()
  })

  // A subframe is not the window.
  it('refuses a publish that did not come from the window’s main frame', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    ipc.publish(sender({ subframe: true }).event, [ITEM])
    expect(install).not.toHaveBeenCalled()
  })

  it('names the chosen command back to the window that published the menu', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    const window = sender()
    ipc.publish(window.event, [ITEM])
    const choose = install.mock.calls[0]?.[1] as (command: string) => void
    choose('close-pane')

    expect(window.sent).toEqual([{ channel: MENU_COMMAND_CHANNEL, command: 'close-pane' }])
  })

  // A menu outlives its window; a click in that gap is dropped rather than thrown.
  it('says nothing to a window that has gone', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    const window = sender({ destroyed: true })
    ipc.publish(window.event, [ITEM])
    const choose = install.mock.calls[0]?.[1] as (command: string) => void
    expect(() => choose('close-pane')).not.toThrow()
    expect(window.sent).toEqual([])
  })

  // The app outlives its last window on macOS; that window's items must not.
  it('takes the items away with the window that published them', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    const window = sender()
    ipc.publish(window.event, [ITEM])
    ipc.publish(window.event, [{ ...ITEM, enabled: false }])
    window.destroy()

    expect(install).toHaveBeenCalledTimes(3)
    expect(install.mock.calls[2]?.[0]).toEqual([])
  })

  it('leaves a newer window’s menu alone when an older window goes', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    installMenuBar(ipc.ipc, { install, fromMainFrame })

    const older = sender()
    const newer = sender()
    ipc.publish(older.event, [ITEM])
    ipc.publish(newer.event, [{ ...ITEM, label: 'Close this pane' }])
    older.destroy()

    expect(install).toHaveBeenCalledTimes(2)
    newer.destroy()
    expect(install).toHaveBeenCalledTimes(3)
    expect(install.mock.calls[2]?.[0]).toEqual([])
  })

  it('stops listening once uninstalled', () => {
    const install = vi.fn()
    const ipc = fakeIpc()
    const uninstall = installMenuBar(ipc.ipc, { install, fromMainFrame })

    expect(ipc.listeners).toBe(1)
    uninstall()
    expect(ipc.listeners).toBe(0)
    ipc.publish(sender().event, [ITEM])
    expect(install).not.toHaveBeenCalled()
  })
})
