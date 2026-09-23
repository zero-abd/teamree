// The application menu: the platform's roles plus the window's own commands
// (see `menuBar.ts`). No `close` role: Electron's default Cmd+W closed the
// whole window before the renderer's "Close pane" could see the key.
//
// On macOS a menu accelerator is a key equivalent, performed by AppKit before
// the page sees the keypress, so the menu owns every chord it claims; a
// disabled item falls through to the renderer, which declines on the same
// predicate. `registerAccelerator: false` keeps Windows and Linux on the
// renderer as the one dispatcher and is documented as a no-op on macOS —
// single dispatch either way.
//
// The Edit roles do real work: xterm has no clipboard, so Cmd+C/Cmd+V in a pane
// are those items. The menu claims them first, so a copy with nothing selected
// is a no-op rather than the interrupt; taking the accelerator off would cost
// Cmd+C/V in every text field. Reload is offered only under a dev server: Cmd+R
// throws every pane view away silently.

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuBarItem } from './menuBar'

export type ApplicationMenuOptions = {
  /** Defaults to this process's platform; named so the shape can be asserted. */
  platform?: NodeJS.Platform
  /** True under `electron-vite dev`, where reloading the renderer is wanted. */
  developing?: boolean
  /** Asks GitHub for a newer release; omitted, the item is not offered. Sits under About, where a Mac user looks. */
  checkForUpdates?: () => void
  /**
   * teamree's own commands as the window last described them. Absent until the
   * window has published: the menu is installed before the first window exists.
   */
  commands?: {
    items: readonly MenuBarItem[]
    choose: (command: string) => void
  }
}

export function applicationMenuTemplate(options: ApplicationMenuOptions = {}): MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform
  const mac = platform === 'darwin'

  /** A top-level menu's name; the `&` mnemonic is not stripped on macOS, where it draws as "&File". */
  const top = (name: string): string => (mac ? name : `&${name}`)

  /** The published items of one menu, as menu items. Empty when there are none. */
  const inSection = (section: string): MenuItemConstructorOptions[] => {
    const commands = options.commands
    if (!commands) return []
    return commands.items
      .filter((item) => item.section === section)
      .map((item) => ({
        label: item.label,
        // Electron reads an empty accelerator as a fault.
        accelerator: item.accelerator === '' ? undefined : item.accelerator,
        // The same predicate the window's key handler refuses on.
        enabled: item.enabled,
        // See the top of this file.
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
              // No accelerator: one invented for it would be taken from the renderer.
              { label: 'Check for Updates…', click: options.checkForUpdates }
            ] as MenuItemConstructorOptions[])
          : []),
        // Settings lives in the app menu on this platform.
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

    // No Close Window here either; see the top of this file.
    const file = inSection('file')
    if (file.length > 0) template.push({ label: top('File'), submenu: file })
  } else {
    // Quit and the app-menu items live here off macOS. No Close Window: Ctrl+W is the pane's.
    template.push({
      label: top('File'),
      submenu: [...before([...inSection('file'), ...inSection('application')]), { role: 'quit' }]
    })
  }

  template.push({
    label: top('Edit'),
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
      ...after(inSection('edit'))
    ]
  })

  template.push({
    label: top('View'),
    submenu: [
      ...(options.developing === true
        ? ([{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }] as const)
        : []),
      ...before(inSection('view')),
      // Terminal text size, in place of the zoom roles that scaled the whole window.
      ...before(inSection('text')),
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' }
    ]
  })

  template.push({
    label: top('Window'),
    // Close Window is the omission this file exists for.
    submenu: [
      ...before(inSection('window')),
      { role: 'minimize' },
      { role: 'zoom' },
      ...(mac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : [])
    ]
  })

  // The `help` role is what attaches the system's own Help search on macOS.
  const help = inSection('help')
  if (help.length > 0) template.push({ label: top('Help'), role: 'help', submenu: help })

  return template
}
