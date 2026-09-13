// The application menu, and the one item it deliberately does not have.
//
// An app that sets no menu gets Electron's default one, and on macOS that
// menu's File menu is a single "Close Window" bound to Cmd+W. A menu key
// equivalent is consumed before the key reaches the focused web contents, so
// the renderer's Cmd+W — "Close pane", which every pane's close button, the
// empty-state legend and the palette all advertise — never fires and the whole
// window closes instead. `window-all-closed` does not quit on darwin, so what
// is left is a running app with no window and none of its window-local state:
// which pane had focus, what the palette was showing, every pane's scrollback
// as the user had scrolled it.
//
// So the menu is built here and the `close` role is simply not in it. Cmd+W
// reaches the renderer, which closes the pane. Everything else a macOS app is
// expected to have is present — About, Services, Hide, Quit, Minimize, Zoom —
// and so are the Edit roles, which are not decoration: xterm has no clipboard
// of its own, and Cmd+C and Cmd+V inside a pane are these menu items doing the
// work.
//
// Reload is the same trap one key over. Cmd+R throws away every pane view, the
// sidebar, the palette and the dashboard, silently and with no way back, for a
// keystroke people press out of habit. It is offered only when a dev server is
// what is being rendered, which is the only time reloading is the point.
//
// Nothing here is invented: every item is an Electron role, so each one does
// what the platform's own menu of that name does, and there is no menu entry
// for a command this app does not have.

import type { MenuItemConstructorOptions } from 'electron'

export type ApplicationMenuOptions = {
  /** Defaults to this process's platform; named so the shape can be asserted. */
  platform?: NodeJS.Platform
  /** True under `electron-vite dev`, where reloading the renderer is wanted. */
  developing?: boolean
}

export function applicationMenuTemplate(options: ApplicationMenuOptions = {}): MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform
  const mac = platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (mac) {
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
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
  } else {
    // The app menu is where Quit lives on macOS; everywhere else it is here.
    // No Close Window item on this platform either: Ctrl+W is the pane's.
    template.push({ label: '&File', submenu: [{ role: 'quit' }] })
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
      { role: 'selectAll' }
    ]
  })

  template.push({
    label: '&View',
    submenu: [
      ...(options.developing === true
        ? ([{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }] as const)
        : []),
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
    // Minimize and Zoom, and on macOS the one item that is about every window
    // rather than this one. Close Window is the omission this file exists for.
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'zoom' }]
  })

  return template
}
