// The application menu: the platform's own items, this app's twelve commands,
// and the one item that is deliberately not here.
//
// macOS's guidance on menu bars opens with the plainest sentence in it — use
// the menu bar to give people easy access to all the commands they need to do
// things in your app — and for a long time this file did the opposite. Every
// item in it was a stock Electron role: About, Services, Hide, Quit, the Edit
// roles, zoom, full screen, DevTools, Minimize, Zoom, Front. Not one thing
// teamree itself does was in the menu bar. The whole command set — new task,
// new terminal, split, close pane, find, the palette, the dashboard, the
// sidebar, settings, help — was reachable by a chord nobody had been told, or
// by finding the right thing to click. That is not only a discoverability
// problem: the menu bar is what VoiceOver walks and what the Help menu's own
// search searches, and neither had anything to find.
//
// So the commands are here now, and they come from the window rather than from
// a second list written here. `src/main/menuBar.ts` explains that arrangement;
// the short of it is that the labels, the chords and which items are live are
// all facts about the window, held there in one table, and a copy of any of
// them in this process could only ever drift out of step with the chord that
// actually fires.
//
// **The omission this file has always existed for stays.** An app that sets no
// menu gets Electron's default one, whose File menu is a single "Close Window"
// bound to Cmd+W. A menu key equivalent is consumed before the key reaches the
// focused web contents, so the renderer's Cmd+W — "Close pane" — never fired
// and the whole window closed instead, taking every pane's scrollback and the
// focus and the palette with it. The `close` role is therefore still not in
// this menu. What is in it now is teamree's own Close pane, on the same Cmd+W:
// the key is consumed by *that* item, which closes a pane, which is what the
// key was always advertised to do.
//
// That is the shape of the whole change, and it is worth saying once plainly,
// because getting it wrong is how one Cmd+D splits two panes. On macOS a menu
// item's accelerator *is* its key equivalent, AppKit performs a key equivalent
// before the event reaches the page, and so the menu owns every one of these
// chords: the item runs, the window is told, and the renderer's key listener
// never sees the keypress at all. Where the item is disabled AppKit does not
// perform it and the key falls through to the page, where the renderer's own
// handler declines it against the same predicate that greyed the item out. One
// layer acts, either way.
//
// `registerAccelerator: false` is set on every one of these items all the same.
// On Windows and Linux it means what it says — the chord is displayed but not
// registered, so those platforms keep the renderer as the one dispatcher. On
// macOS Electron documents the option as having no effect, so the menu keeps
// the key there. Both of those are single dispatch, which is why the option is
// set rather than agonised over: whichever of the two a platform does, exactly
// one layer ends up acting on one keypress.
//
// The rest is unchanged and still not invented. The Edit roles are not
// decoration: xterm has no clipboard of its own, and Cmd+C and Cmd+V inside a
// pane are those menu items doing the work. Reload is the same trap one key
// over — Cmd+R throws away every pane view, the sidebar, the palette and the
// dashboard, silently, for a keystroke people press out of habit — so it is
// offered only when a dev server is what is being rendered.
//
// And "Check for Updates…" still has no role because Electron has none to
// offer; it is under About because that is where a Mac user looks for it, and
// it appears only when the caller hands over something for it to do.

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuBarItem } from './menuBar'

export type ApplicationMenuOptions = {
  /** Defaults to this process's platform; named so the shape can be asserted. */
  platform?: NodeJS.Platform
  /** True under `electron-vite dev`, where reloading the renderer is wanted. */
  developing?: boolean
  /**
   * Asks GitHub whether there is a newer release, and leaves the answer to the
   * window. Omitted, the item is not offered at all — a menu item that does
   * nothing is worse than one that is absent.
   *
   * It sits directly under About, with a separator between it and Services,
   * because that is where a Mac user looks for it: every Mac app that checks
   * for its own updates puts the item there, and a menu that agrees with the
   * platform is one nobody has to be shown.
   */
  checkForUpdates?: () => void
  /**
   * teamree's own commands, as the window last described them, and the way to
   * say one was chosen.
   *
   * One field rather than two, so there is no way to ask for the items without
   * also supplying what they do. Absent until the window has published — the
   * menu is installed before the first window exists, on purpose, so the bar is
   * never Electron's default even for a moment — and in that gap the menu is
   * the roles alone rather than a row of items with nothing behind them.
   */
  commands?: {
    items: readonly MenuBarItem[]
    choose: (command: string) => void
  }
}

export function applicationMenuTemplate(options: ApplicationMenuOptions = {}): MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform
  const mac = platform === 'darwin'

  /** The published items of one menu, as menu items. Empty when there are none. */
  const inSection = (section: string): MenuItemConstructorOptions[] => {
    const commands = options.commands
    if (!commands) return []
    return commands.items
      .filter((item) => item.section === section)
      .map((item) => ({
        label: item.label,
        accelerator: item.accelerator,
        // The window's own answer to "would this do anything right now",
        // computed by the same function its key handler refuses on. An item
        // that cannot act is grey rather than pressable and ignored.
        enabled: item.enabled,
        // Display-only where the platform honours it; see the note at the top
        // of this file for why it is set even on the platform that ignores it.
        registerAccelerator: false,
        click: () => commands.choose(item.command)
      }))
  }

  /** `items` with a separator in front, or nothing at all when it is empty. */
  const after = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.length > 0 ? [{ type: 'separator' }, ...items] : []

  /** `items` with a separator behind, or nothing at all when it is empty. */
  const before = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.length > 0 ? [...items, { type: 'separator' }] : []

  const template: MenuItemConstructorOptions[] = []

  if (mac) {
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        ...(options.checkForUpdates
          ? ([
              { type: 'separator' },
              // No accelerator: this one has no platform binding to claim, and
              // one invented for it would be one taken from the renderer.
              { label: 'Check for Updates…', click: options.checkForUpdates }
            ] as MenuItemConstructorOptions[])
          : []),
        // Settings lives in the menu named after the app on this platform, and
        // a Mac user looks nowhere else for it.
        ...after(inSection('application')),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })

    // No Close Window here either; see the top of this file. The menu exists at
    // all only once there is something of the app's own to put in it.
    const file = inSection('file')
    if (file.length > 0) template.push({ label: '&File', submenu: file })
  } else {
    // The app menu is where Quit lives on macOS; everywhere else it is here,
    // and so is everything that would have gone in it. No Close Window on this
    // platform either: Ctrl+W is the pane's.
    template.push({
      label: '&File',
      submenu: [...before([...inSection('file'), ...inSection('application')]), { role: 'quit' }]
    })
  }

  template.push({
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      // Find is in the Edit menu on every platform this runs on, and has been
      // since before the app existed.
      ...after(inSection('edit'))
    ]
  })

  template.push({
    label: '&View',
    submenu: [
      ...(options.developing === true
        ? ([{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }] as const)
        : []),
      // What the window shows, above what the platform does to any window.
      ...before(inSection('view')),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' }
    ]
  })

  template.push({
    label: '&Window',
    // Splitting and walking panes is arranging the window, which is what this
    // menu is for; then Minimize and Zoom, and on macOS the one item that is
    // about every window rather than this one. Close Window is the omission
    // this file exists for.
    submenu: [
      ...before(inSection('window')),
      { role: 'minimize' },
      { role: 'zoom' },
      ...(mac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : [])
    ]
  })

  // Every macOS app has a Help menu and this one did not. The `help` role is
  // what makes it that menu rather than a menu that happens to be called Help:
  // on macOS it is the one the system's own Help search is attached to.
  const help = inSection('help')
  if (help.length > 0) template.push({ label: '&Help', role: 'help', submenu: help })

  return template
}
