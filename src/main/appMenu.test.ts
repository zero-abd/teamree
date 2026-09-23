import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, type ApplicationMenuOptions } from './appMenu'
import type { MenuBarItem } from './menuBar'
import { menuBarSpec } from '../renderer/src/menu/menuBar'
import type { CommandState } from '../renderer/src/keyboard/workspaceCommands'
import type { WorkspaceCommand } from '../renderer/src/keyboard/workspaceShortcuts'

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

/** The labels of one menu, separators shown as a rule, so order can be read. */
function labelsOf(template: MenuItemConstructorOptions[], menu: string): string[] {
  return submenuOf(template, menu).map((item) => item.label ?? item.role ?? (item.type === 'separator' ? '—' : '?'))
}

/**
 * What a top-level menu is called on one platform.
 *
 * The `&` is a Windows and Linux mnemonic marker — Alt-F opens `&File` there,
 * and the character is not drawn — and macOS has nothing of the kind, so a menu
 * named `&File` on a Mac is a menu with an ampersand in its title. Written once
 * here so every assertion below reads the name and the platform together
 * instead of hard-coding the marker on the platform that does not want it.
 */
function menuName(platform: NodeJS.Platform, name: string): string {
  return platform === 'darwin' ? name : `&${name}`
}

/**
 * A window's published menus, of the shape `menuBar.ts` parses.
 *
 * Taken from the renderer's own `menuBarSpec` rather than written out here, and
 * that is the repair: a hand-copied fixture said the ⌘K item was called "Go to
 * anything" long after the window had started publishing "Go to worktree or
 * command", and every assertion in this file passed against the wording nobody
 * ships. Labels, chords and sections now arrive by the path the product uses,
 * so a label that changes in the table changes here.
 *
 * Which menus the real commands are read under is still the window's decision
 * and is asserted where it is made, `src/renderer/src/menu/menuBar.test.ts`.
 * What is asserted here is only the weaving — that a published item lands in
 * the menu it asked for, above or below the platform's own items, with its
 * chord shown and its click wired — so this takes a slice of the real menu
 * rather than all sixteen commands, one per section and two more in File.
 */
const SHOWN: readonly WorkspaceCommand[] = [
  'open-settings',
  'new-worktree',
  'new-terminal',
  'close-pane',
  'find-in-pane',
  'open-palette',
  // The one command in the slice with no chord, which is the other thing an
  // item's accelerator can be.
  'open-appearance',
  'split-right',
  'open-help'
]

/**
 * Which of them this fixture calls dead, so the greying assertions have both
 * answers to check. Enablement is the window's own predicate over its own
 * state, tested there; what matters to this process is that it is carried
 * through untouched, which needs a mix rather than a real state.
 */
const DEAD: readonly WorkspaceCommand[] = ['new-terminal', 'close-pane', 'find-in-pane', 'split-right']

/** A window with nothing open in it, which is what a first launch looks like. */
const EMPTY: CommandState = {
  consent: {},
  dialog: null,
  projects: [],
  worktrees: [],
  activeWorktreeId: null,
  layouts: {},
  watches: [],
  focusedWatchId: null,
  statuses: {},
  pushing: false
}

const SPEC: readonly MenuBarItem[] = menuBarSpec(EMPTY)
  .filter((item) => SHOWN.includes(item.command))
  .map((item) => ({ ...item, enabled: !DEAD.includes(item.command) }))

/** The label the window publishes for one command, for an assertion to name. */
function shipped(command: WorkspaceCommand): string {
  const item = SPEC.find((entry) => entry.command === command)
  if (item === undefined) throw new Error(`no published item for ${command}`)
  return item.label
}

function published(choose: (command: string) => void = () => {}): ApplicationMenuOptions['commands'] {
  return { items: SPEC, choose }
}

describe('the application menu', () => {
  // The defect this file exists for: Electron's default menu binds Cmd+W to
  // "Close Window", which is consumed before the key reaches the renderer, so
  // the pane the user meant to close survives and the window does not.
  it('has no Close Window anywhere, and invents no accelerator of its own', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      // With the window's commands in it, which is when there is most to get
      // wrong: `close` must still be absent even though Cmd+W is now spoken
      // for, and it is spoken for by an item that closes a pane.
      const template = applicationMenuTemplate({ platform, commands: published() })
      expect(roles(template), platform).not.toContain('close')

      // Every accelerator in the menu belongs to a command the window
      // published. Nothing here writes one down: a chord invented in this
      // process is a chord taken off the renderer with nothing to say so.
      const accelerators = items(template)
        .filter((item) => item.accelerator !== undefined)
        .map((item) => item.accelerator)
      expect(accelerators.sort(), platform).toEqual(
        SPEC.map((item) => item.accelerator)
          .filter((accelerator) => accelerator !== '')
          .sort()
      )
    }
  })

  // xterm has no clipboard of its own: copy and paste inside a pane are these
  // menu items. A menu that dropped them would break selecting text in a pane.
  it('keeps the edit roles a terminal needs', () => {
    const edit = roles(submenuOf(applicationMenuTemplate({ platform: 'darwin' }), 'Edit'))
    expect(edit).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
  })

  // The mnemonic marker is a Windows and Linux convention and macOS neither
  // strips it nor acts on it, so every top-level menu was drawn with an
  // ampersand in front of its name on the platform this app is used on.
  it('marks a mnemonic only where the platform has them', () => {
    const mac = applicationMenuTemplate({ platform: 'darwin', commands: published() })
    for (const item of mac) expect(item.label ?? '').not.toContain('&')
    expect(mac.map((item) => item.label).filter((label) => label !== undefined)).toEqual([
      'File',
      'Edit',
      'View',
      'Window',
      'Help'
    ])

    for (const platform of ['win32', 'linux'] as const) {
      const template = applicationMenuTemplate({ platform, commands: published() })
      expect(
        template.map((item) => item.label),
        platform
      ).toEqual(['&File', '&Edit', '&View', '&Window', '&Help'])
    }
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
    expect(roles(submenuOf(template, 'Window'))).toEqual(['minimize', 'zoom', 'front'])
  })

  it('puts Quit in the File menu where there is no app menu to hold it', () => {
    const template = applicationMenuTemplate({ platform: 'win32' })
    expect(template[0]?.label).toBe(menuName('win32', 'File'))
    expect(roles(submenuOf(template, menuName('win32', 'File')))).toEqual(['quit'])
    expect(roles(submenuOf(template, menuName('win32', 'Window')))).toEqual(['minimize', 'zoom'])
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

// Apple's own first sentence about menu bars is that it is where all the
// commands people need to do things in your app live. Until these items existed
// this menu was Electron's roles and nothing else — not one thing teamree does
// was in it, and a new user, VoiceOver, and the Help menu's own search all had
// nothing to find.
describe('the window’s own commands in the menu bar', () => {
  it('reads each published item under the menu it asked for', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })

    // The app menu, where this platform keeps an app's settings and where a Mac
    // user looks for nothing else.
    const appMenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : []
    expect(appMenu.map((item) => item.label ?? item.role)).toContain('Settings…')

    // In the order the window published them, which is the order a File menu is
    // read in rather than the order the shortcut table happens to be written.
    expect(labelsOf(template, 'File')).toEqual(['New task', 'New terminal', 'Close pane'])
    expect(labelsOf(template, 'Edit').slice(-2)).toEqual(['—', 'Find in pane'])
    // The window's own word for ⌘K, read out of the published menu rather than
    // written down again here.
    expect(labelsOf(template, 'View').slice(0, 3)).toEqual([shipped('open-palette'), shipped('open-appearance'), '—'])
    expect(shipped('open-palette')).toBe('Go to worktree or command')
    expect(labelsOf(template, 'Window')).toEqual(['Split pane right', '—', 'minimize', 'zoom', '—', 'front'])
    expect(labelsOf(template, 'Help')).toEqual([shipped('open-help')])
  })

  // The `help` role is what makes a menu called Help *be* the Help menu on
  // macOS — the one the system's own search field is attached to. A menu that
  // merely carried the word would look right and search nothing.
  it('gives the Help menu the role that makes it the platform’s Help menu', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })
    expect(template.find((item) => item.label === 'Help')?.role).toBe('help')
  })

  // This is the one that keeps one keypress from doing one thing. An
  // accelerator written here that the renderer does not bind is a key that
  // stops working; a chord the renderer binds that is shown wrong here is worse
  // still. Every one of these is the window's own spelling, passed through.
  it('shows exactly the chord the window published, and never one of its own', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })
    for (const item of SPEC) {
      const found = items(template).find((entry) => entry.label === item.label)
      // A command the window binds to no key publishes an empty accelerator,
      // and the item is built with none at all: Electron reads a string it
      // cannot parse as a fault rather than as "no key".
      expect(found?.accelerator, item.command).toBe(item.accelerator === '' ? undefined : item.accelerator)
    }
    expect(shipped('open-appearance')).toBe('Appearance…')
    expect(SPEC.find((item) => item.command === 'open-appearance')?.accelerator).toBe('')
  })

  // Display-only where the platform honours it, so Windows and Linux keep the
  // renderer as the single dispatcher. macOS ignores the option and takes the
  // key for the menu — which is also single dispatch, because the renderer's
  // listener never sees a key the menu consumed.
  it('asks not to register any of these accelerators with the system', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = applicationMenuTemplate({ platform, commands: published() })
      // Bar the item with no chord, which is not asking the system for a key
      // and so has nothing to ask it not to register.
      const commandItems = items(template).filter((item) => item.accelerator !== undefined)
      expect(commandItems.length, platform).toBe(SPEC.filter((item) => item.accelerator !== '').length)
      expect(
        commandItems.every((item) => item.registerAccelerator === false),
        platform
      ).toBe(true)
    }
  })

  // The standing rule of this app: nothing is offered that cannot work. The
  // window says which of its commands could do anything right now, and a menu
  // bar is where breaking that shows most, because every item is on screen at
  // once.
  it('greys the items the window said could not do anything', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })
    for (const item of SPEC) {
      const found = items(template).find((entry) => entry.label === item.label)
      expect(found?.enabled, item.command).toBe(item.enabled)
    }
  })

  it('names the command back when an item is chosen', () => {
    const choose = vi.fn()
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published(choose) })
    const item = items(template).find((entry) => entry.label === 'New task')

    item?.click?.(undefined as never, undefined, undefined as never)
    expect(choose).toHaveBeenCalledExactlyOnceWith('new-worktree')
  })

  // Before the first window has rendered there is nothing to say, and a row of
  // items with nothing behind them would be worse than the platform's roles
  // alone — which is what this menu was until these items existed.
  it('offers no command menu at all until the window has published one', () => {
    const template = applicationMenuTemplate({ platform: 'darwin' })
    expect(template.map((item) => item.label)).not.toContain('File')
    expect(template.map((item) => item.label)).not.toContain('Help')
    expect(items(template).every((item) => item.accelerator === undefined)).toBe(true)
  })

  // A window from a build that knows a menu this one does not. Nowhere is the
  // right place for it: an item read under a heading this process invented
  // would be an item nobody could have meant to put there.
  it('drops an item published for a menu it does not have', () => {
    const stray: MenuBarItem = {
      command: 'open-sideboard',
      label: 'The sideboard',
      accelerator: 'CommandOrControl+9',
      section: 'sideboard',
      enabled: true
    }
    const template = applicationMenuTemplate({
      platform: 'darwin',
      commands: { items: [...SPEC, stray], choose: () => {} }
    })
    expect(items(template).map((item) => item.label)).not.toContain('The sideboard')
  })

  // There is no app menu off this platform, so what would have been in it goes
  // where that platform keeps the same things: the File menu, above Quit.
  it('folds the application items into File where there is no app menu', () => {
    const template = applicationMenuTemplate({ platform: 'win32', commands: published() })
    expect(labelsOf(template, menuName('win32', 'File'))).toEqual([
      'New task',
      'New terminal',
      'Close pane',
      'Settings…',
      '—',
      'quit'
    ])
  })
})
