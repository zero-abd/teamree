// The main process's end of the menu bar: the window publishes its own menus
// (labels, chords, enablement live in `WORKSPACE_SHORTCUTS` there) and this
// rebuilds them, checking every field first since `Menu.buildFromTemplate`
// takes whatever it is handed. One window at a time.

import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

/** Keep both in step with `src/preload/index.ts`, which repeats the literals. */
export const MENU_PUBLISH_CHANNEL = 'teamree:menu:publish'
export const MENU_COMMAND_CHANNEL = 'teamree:menu:command'

/** One item of teamree's own menus. `section` is a plain string: an unrecognised one goes nowhere. */
export type MenuBarItem = {
  command: string
  label: string
  /** Electron's spelling of the chord, e.g. `CommandOrControl+Shift+D`, or empty for an item with no key. */
  accelerator: string
  section: string
  enabled: boolean
}

/**
 * The only spelling of an accelerator the window can produce; a page that could
 * publish any string could publish `CommandOrControl+Q`. Named keys are listed
 * one by one: `Tab`, `Escape` and `F4` are keys a menu item can take off the platform.
 */
const ACCELERATOR = /^CommandOrControl(\+Alt)?(\+Shift)?\+([^+\s]|Up|Down|Left|Right|Enter)$/

/** The table has twelve; a page publishing hundreds is not describing a menu. */
const MOST_ITEMS = 64

function isMenuBarItem(value: unknown): value is MenuBarItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.command === 'string' &&
    item.command.length > 0 &&
    typeof item.label === 'string' &&
    item.label.length > 0 &&
    typeof item.accelerator === 'string' &&
    (item.accelerator === '' || ACCELERATOR.test(item.accelerator)) &&
    typeof item.section === 'string' &&
    typeof item.enabled === 'boolean'
  )
}

/**
 * The items, rebuilt field by field so no `click`, `role` or `submenu` reaches
 * `Menu.buildFromTemplate`; null on any bad item, since half a menu bar is worse than the old one.
 */
export function readMenuBarItems(value: unknown): MenuBarItem[] | null {
  if (!Array.isArray(value) || value.length > MOST_ITEMS) return null
  const items: MenuBarItem[] = []
  for (const entry of value) {
    if (!isMenuBarItem(entry)) return null
    items.push({
      command: entry.command,
      label: entry.label,
      accelerator: entry.accelerator,
      section: entry.section,
      enabled: entry.enabled
    })
  }
  return items
}

export type MenuBarHost = {
  /** Installs a menu for these items; called again on every publish. See `useMenuBar.ts`. */
  install: (items: readonly MenuBarItem[], choose: (command: string) => void) => void
  /** The window's main frame is the only thing allowed to name its menus. */
  fromMainFrame: (event: IpcMainEvent) => boolean
}

/** Listens for the window's menu descriptions. A click after the publisher is gone is dropped, not thrown. */
export function installMenuBar(ipc: IpcMain, host: MenuBarHost): () => void {
  // On macOS the app outlives its last window; a menu left as it was would
  // swallow ⌘N and ⌘W. The items go with the web contents that published them.
  let published: WebContents | null = null

  const onPublish = (event: IpcMainEvent, payload: unknown): void => {
    if (!host.fromMainFrame(event)) return
    const items = readMenuBarItems(payload)
    if (!items) return

    const sender: WebContents = event.sender
    host.install(items, (command) => {
      if (!sender.isDestroyed()) sender.send(MENU_COMMAND_CHANNEL, command)
    })

    if (published !== sender) {
      published = sender
      sender.once('destroyed', () => {
        if (published !== sender) return
        published = null
        host.install([], () => {})
      })
    }
  }

  ipc.on(MENU_PUBLISH_CHANNEL, onPublish)
  return () => ipc.removeAllListeners(MENU_PUBLISH_CHANNEL)
}
