// What the main process will and will not draw in its menu bar.
//
// The window describes its own menus and this process builds them, which is the
// only arrangement in which there is one list of teamree's commands rather than
// two. The price of it is that a message decides what goes into
// `Menu.buildFromTemplate`, so the parse below is the boundary, and these are
// the tests of that boundary: what shape is accepted, what is dropped on the
// floor, and who is allowed to send it.
//
// No Electron. `ipcMain` and a web contents are the two things faked, because a
// test that needed a packaged app to run would not be run.

import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainEvent } from 'electron'
import { installMenuBar, MENU_COMMAND_CHANNEL, MENU_PUBLISH_CHANNEL, readMenuBarItems } from './menuBar'

/** One well-formed item, which each case below spoils in exactly one way. */
const ITEM = {
  command: 'close-pane',
  label: 'Close pane',
  accelerator: 'CommandOrControl+W',
  section: 'file',
  enabled: true
}

describe('reading a published menu', () => {
  it('takes a list of items and gives back exactly those fields', () => {
    expect(readMenuBarItems([ITEM])).toEqual([ITEM])
    // A window with nothing to offer is a legitimate answer, not a broken one.
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
    // An item with no name is an item nobody can read, and an item with no
    // command behind it is one that would do nothing when chosen.
    expect(readMenuBarItems([{ ...ITEM, label: '' }])).toBeNull()
    expect(readMenuBarItems([{ ...ITEM, command: '' }])).toBeNull()
  })

  // Half a menu bar is worse than the one already installed, because nothing on
  // screen says which half is missing.
  it('drops the whole list rather than the item it could not read', () => {
    expect(readMenuBarItems([ITEM, { ...ITEM, section: 4 }])).toBeNull()
  })

  // The reason the items are rebuilt field by field rather than passed along.
  // `Menu.buildFromTemplate` reads `click`, `role` and `submenu` off whatever it
  // is handed, and what it is handed here arrived over IPC.
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
} {
  const sent: { channel: string; command: string }[] = []
  const contents = {
    isDestroyed: () => options.destroyed === true,
    send: (channel: string, command: string) => sent.push({ channel, command }),
    mainFrame: { name: 'main' }
  }
  return {
    event: { sender: contents, senderFrame: options.subframe === true ? { name: 'other' } : contents.mainFrame },
    sent
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

  // The same guard the folder picker and the reveal make. A subframe is not the
  // window, and must not get to name the items of the application's menu bar.
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

  // A menu outlives the window it was built for by however long it takes the
  // next one to publish. A click in that gap is dropped rather than thrown.
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
