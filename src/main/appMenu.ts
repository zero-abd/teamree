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

import type { AboutPanelOptionsOptions, MenuItemConstructorOptions } from 'electron'
import { DEV_VERSION } from './appVersion'
import type { MenuBarItem } from './menuBar'
import { RELEASE_HOST, UPDATE_REPOSITORY } from './updates/latestRelease'

const SITE_URL = 'https://teamree.us'

const REPOSITORY_URL = `https://${RELEASE_HOST}/${UPDATE_REPOSITORY}`

export type ApplicationMenuOptions = {
  /** Defaults to this process's platform; named so the shape can be asserted. */
  platform?: NodeJS.Platform
  /** True under `electron-vite dev`, where reloading the renderer is wanted. */
  developing?: boolean
  /** Offers Toggle Developer Tools; see `offersDevTools`. */
  devTools?: boolean
  /** Asks GitHub for a newer release; omitted, the item is not offered. Sits under About, where a Mac user looks. */
  checkForUpdates?: () => void
  /** The Help menu's web pages; omitted, they are not offered. */
  links?: {
    version: string
    /** `process.getSystemVersion()`. */
    systemVersion: string
    open: (url: string) => void
  }
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
      ...(options.devTools === true ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as const) : [])
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
  const links = options.links ? helpLinks(options.links, mac, platform) : []
  const updates: MenuItemConstructorOptions[] = options.checkForUpdates
    ? [{ label: 'Check for Updates…', click: options.checkForUpdates }]
    : []
  const shortcuts = inSection('help')
  const help = [shortcuts, updates, links]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: 'separator' } as const, ...group]))
  if (help.length > 0) template.push({ label: top('Help'), role: 'help', submenu: help })

  return template
}

/** A dev server, or `TEAMREE_DEVTOOLS=1` for debugging a built app. */
export function offersDevTools(env: NodeJS.ProcessEnv): boolean {
  return env.ELECTRON_RENDERER_URL !== undefined || env.TEAMREE_DEVTOOLS === '1'
}

/** `iconPath` is read off macOS only; there the panel draws the app's icon. */
export function aboutPanelOptions(version: string, iconPath?: string): AboutPanelOptionsOptions {
  return {
    applicationName: 'teamree',
    applicationVersion: version,
    // Empty hides the bundle's build number, which is Electron's when unpackaged.
    version: '',
    copyright: 'Copyright © teamree contributors',
    // `website` is read on Linux only; macOS and Windows show the credits.
    credits: `${SITE_URL}\n${REPOSITORY_URL}`,
    website: SITE_URL,
    ...(iconPath === undefined ? {} : { iconPath })
  }
}

function helpLinks(
  links: NonNullable<ApplicationMenuOptions['links']>,
  mac: boolean,
  platform: NodeJS.Platform
): MenuItemConstructorOptions[] {
  const releaseNotes =
    links.version === DEV_VERSION ? `${REPOSITORY_URL}/releases` : `${REPOSITORY_URL}/releases/tag/v${links.version}`
  // Versions only: nothing that names the person or the machine.
  const body = `\n\n---\nteamree ${links.version}\n${mac ? 'macOS' : platform} ${links.systemVersion}\n`
  const issue = `${REPOSITORY_URL}/issues/new?body=${encodeURIComponent(body)}`
  return [
    { label: 'teamree Website', click: () => links.open(SITE_URL) },
    { label: 'Release Notes', click: () => links.open(releaseNotes) },
    { label: 'Report an Issue', click: () => links.open(issue) },
    { label: 'Star on GitHub', click: () => links.open(REPOSITORY_URL) }
  ]
}
