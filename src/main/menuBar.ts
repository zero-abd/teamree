// The main process's end of the menu bar: it takes the window's description of
// teamree's own menus, and it hands a choice back.
//
// Only this process can install a menu bar, and it is the one process that
// knows nothing about what this app does. The commands, their chords, their
// wording and whether each of them could do anything right now are all facts
// about the window, held in one table there — `WORKSPACE_SHORTCUTS` and the
// placement record beside it. Rather than keep a second copy of any of that
// here, where it could only ever drift, the window sends a finished description
// and this rebuilds the menu from it. Nothing in this file knows what a
// worktree is.
//
// Which means everything arriving on this channel is checked before it is drawn.
// `readMenuBarItems` rebuilds each item out of the fields it verified and drops
// the lot on anything that is not the shape it expects — the same rule
// `readWatchedPaneEvent` follows in the renderer, and for the same reason: a
// menu is built with `Menu.buildFromTemplate`, which will happily be handed
// whatever came off the wire. Today the only sender is the window's own main
// frame, which is checked as well; the parse is what keeps that from being the
// only thing standing between a message and an application menu.
//
// One window at a time is what this assumes, which is what teamree has: the
// choice goes back to whichever web contents published the menu that is
// currently installed, because that menu was built out of *its* state and an
// item enabled by one window's panes means nothing to another's.

import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

/** Keep both in step with `src/preload/index.ts`, which repeats the literals. */
export const MENU_PUBLISH_CHANNEL = 'teamree:menu:publish'
export const MENU_COMMAND_CHANNEL = 'teamree:menu:command'

/**
 * One item of teamree's own menus, as the window describes it.
 *
 * `section` is which menu it is read under. It is a plain string here rather
 * than a union of the six the window knows: this process puts an item it does
 * not recognise nowhere at all, which is the behaviour a wider type makes
 * obvious and a narrow one would hide behind a cast.
 */
export type MenuBarItem = {
  command: string
  label: string
  /** Electron's spelling of the chord, e.g. `CommandOrControl+Shift+D`. */
  accelerator: string
  section: string
  enabled: boolean
}

/**
 * The only spelling of an accelerator the window can produce: the platform
 * modifier, optionally Alt and Shift in that order, and one key. Anything else
 * is not a chord from the shortcut table — and a page that could publish any
 * string here could publish `CommandOrControl+Q` and take the key equivalent
 * off Quit, which sits below these items in the same menu.
 *
 * The key is one character, or one of five names spelled out. The names are
 * here because a key can be a chord's key without being a character: the window
 * binds the arrows and Return, and Electron spells those `Up`, `Down` and
 * `Enter`. They are named one by one rather than admitted as "a word", and that
 * is the point of the list — `Tab`, `Escape` and `F4` are keys a menu item can
 * take off the platform itself, and none of them is in the table this is
 * guarding.
 */
const ACCELERATOR = /^CommandOrControl(\+Alt)?(\+Shift)?\+([^+\s]|Up|Down|Left|Right|Enter)$/

/**
 * More items than the window has commands, by a margin, and far fewer than
 * would make a menu bar unusable. The table has twelve; a page publishing
 * hundreds is not describing a menu.
 */
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
    ACCELERATOR.test(item.accelerator) &&
    typeof item.section === 'string' &&
    typeof item.enabled === 'boolean'
  )
}

/**
 * The items, rebuilt field by field, or null if the message was not one.
 *
 * Null rather than a partial list on any bad item: half a menu bar is worse
 * than the one already installed, because the reader cannot tell that anything
 * is missing. Rebuilt rather than passed through so that nothing else a sender
 * put on the object — a `click`, a `role`, a `submenu` — reaches
 * `Menu.buildFromTemplate`.
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
  /**
   * Installs a menu for these items, and is given the way to say one was
   * chosen. Called again on every publish, which is every time the window's
   * answer changes and no more often than that — see `useMenuBar.ts`.
   */
  install: (items: readonly MenuBarItem[], choose: (command: string) => void) => void
  /** The window's main frame is the only thing allowed to name its menus. */
  fromMainFrame: (event: IpcMainEvent) => boolean
}

/**
 * Listens for the window's menu descriptions. Returns the way to stop.
 *
 * The choice is sent back to the web contents that published, and only while it
 * is still there: a menu outlives the window it was built for by however long
 * it takes the next one to publish, and a click in that gap must be dropped
 * rather than thrown.
 */
export function installMenuBar(ipc: IpcMain, host: MenuBarHost): () => void {
  // Whose menu is installed. On macOS the app outlives its last window, and a
  // menu bar left as that window described it is a row of live-looking items
  // that do nothing when chosen and key equivalents that swallow ⌘N and ⌘W
  // rather than letting them fall through. So the window's items go with the
  // window: when the web contents that published them is destroyed, the bar
  // goes back to the platform's roles alone — unless another window has
  // published since, in which case the bar is already its.
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
