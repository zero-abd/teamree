import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate } from './appMenu'

/**
 * Every item in the template, at any depth. Roles are asserted rather than
 * labels or accelerators: a role is a contract with the platform, and its
 * accelerator is Electron's to choose — `close` is Cmd+W wherever it appears,
 * which is the whole reason it must not appear.
 */
function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
}

type MenuRole = NonNullable<MenuItemConstructorOptions['role']>

function roles(template: MenuItemConstructorOptions[]): MenuRole[] {
  return items(template)
    .map((item) => item.role)
    .filter((role): role is MenuRole => role !== undefined)
}

function submenuOf(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const found = template.find((item) => item.label === label)?.submenu
  return Array.isArray(found) ? found : []
}

describe('the application menu', () => {
  // The defect this file exists for: Electron's default menu binds Cmd+W to
  // "Close Window", which is consumed before the key reaches the renderer, so
  // the pane the user meant to close survives and the window does not.
  it('has no Close Window anywhere, and claims no accelerator of its own', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = applicationMenuTemplate({ platform })
      expect(roles(template), platform).not.toContain('close')
      // Nothing here spells an accelerator out: every binding is the role's,
      // so the menu cannot quietly take a key the renderer already uses.
      expect(
        items(template).every((item) => item.accelerator === undefined),
        platform
      ).toBe(true)
    }
  })

  // xterm has no clipboard of its own: copy and paste inside a pane are these
  // menu items. A menu that dropped them would break selecting text in a pane.
  it('keeps the edit roles a terminal needs', () => {
    const edit = roles(submenuOf(applicationMenuTemplate({ platform: 'darwin' }), '&Edit'))
    expect(edit).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
  })

  it('gives macOS the menus a macOS app is expected to have', () => {
    const template = applicationMenuTemplate({ platform: 'darwin' })
    expect(template[0]?.role).toBe('appMenu')
    expect(roles(Array.isArray(template[0]?.submenu) ? template[0].submenu : [])).toEqual([
      'about',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit'
    ])
    expect(roles(submenuOf(template, '&Window'))).toEqual(['minimize', 'zoom', 'front'])
  })

  it('puts Quit in the File menu where there is no app menu to hold it', () => {
    const template = applicationMenuTemplate({ platform: 'win32' })
    expect(template[0]?.label).toBe('&File')
    expect(roles(submenuOf(template, '&File'))).toEqual(['quit'])
    expect(roles(submenuOf(template, '&Window'))).toEqual(['minimize', 'zoom'])
  })

  // Where a Mac user looks for it, which is the only reason it is in a menu at
  // all: the palette already has the same command, and the menu is what
  // somebody who has never opened the palette will find.
  it('puts Check for Updates under About, above Services', () => {
    const checkForUpdates = vi.fn()
    const template = applicationMenuTemplate({ platform: 'darwin', checkForUpdates })
    const appMenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : []
    const labels = appMenu.map((item) => item.label ?? item.role ?? item.type)

    expect(labels.indexOf('Check for Updates…')).toBe(2)
    expect(labels.indexOf('Check for Updates…')).toBeLessThan(labels.indexOf('services'))
    // No accelerator here either: this item has no platform binding to claim,
    // and one invented for it would be one taken from the renderer.
    expect(appMenu.find((item) => item.label === 'Check for Updates…')?.accelerator).toBeUndefined()
  })

  it('runs the check when it is chosen', () => {
    const checkForUpdates = vi.fn()
    const template = applicationMenuTemplate({ platform: 'darwin', checkForUpdates })
    const appMenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : []
    const item = appMenu.find((entry) => entry.label === 'Check for Updates…')

    item?.click?.(undefined as never, undefined, undefined as never)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  // A menu item that does nothing is worse than one that is absent, and a
  // runtime that cannot check — a harness, a build with the check off — hands
  // nothing over.
  it('leaves the item out when there is nothing behind it', () => {
    const appMenu = applicationMenuTemplate({ platform: 'darwin' })[0]?.submenu
    const labels = (Array.isArray(appMenu) ? appMenu : []).map((item) => item.label)
    expect(labels).not.toContain('Check for Updates…')
  })

  // Cmd+R reloads the renderer and takes every pane view, the palette and the
  // sidebar with it, silently. Worth having while a dev server is what is
  // being rendered; a trap in a build somebody works in.
  it('offers reload only against a dev server', () => {
    expect(roles(applicationMenuTemplate({ platform: 'darwin' }))).not.toContain('reload')
    expect(roles(applicationMenuTemplate({ platform: 'darwin', developing: true }))).toContain('reload')
    // Devtools are how a bug gets reported, so they are there either way.
    expect(roles(applicationMenuTemplate({ platform: 'darwin' }))).toContain('toggleDevTools')
  })
})
