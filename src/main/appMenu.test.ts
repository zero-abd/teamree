import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { aboutPanelOptions, applicationMenuTemplate, offersDevTools, type ApplicationMenuOptions } from './appMenu'
import { readMenuBarItems, type MenuBarItem } from './menuBar'
import { menuBarSpec } from '../renderer/src/menu/menuBar'
import { buildPaletteItems } from '../renderer/src/palette/paletteModel'
import type { CommandState } from '../renderer/src/keyboard/workspaceCommands'
import type { WorkspaceCommand } from '../renderer/src/keyboard/workspaceShortcuts'

/** Every item in the template, at any depth. Roles are asserted: `close` is Cmd+W wherever it appears. */
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

/** What a top-level menu is called on one platform; macOS draws the `&` mnemonic literally. */
function menuName(platform: NodeJS.Platform, name: string): string {
  return platform === 'darwin' ? name : `&${name}`
}

/**
 * A slice of the window's published menus, taken from the renderer's own
 * `menuBarSpec`: a hand-copied fixture once passed against wording nobody ships.
 * Which menu each command goes under is asserted in `src/renderer/src/menu/menuBar.test.ts`.
 */
const SHOWN: readonly WorkspaceCommand[] = [
  'open-settings',
  'new-worktree',
  'new-terminal',
  'close-pane',
  'find-in-pane',
  'open-palette',
  // The one command in the slice with no chord.
  'open-appearance',
  'split-right',
  'open-help'
]

/** Which of them this fixture calls dead, so the greying assertions have both answers. */
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

// The window's whole table as it publishes it: one chord main will not read and the menu bar is lost.
describe('the published menu bar', () => {
  it('is read whole by main', () => {
    expect(readMenuBarItems(menuBarSpec(EMPTY))).toEqual(menuBarSpec(EMPTY))
  })
})

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
  // Electron's default menu binds Cmd+W to "Close Window", consumed before the
  // key reaches the renderer's "Close pane".
  it('has no Close Window anywhere, and invents no accelerator of its own', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = applicationMenuTemplate({ platform, commands: published() })
      expect(roles(template), platform).not.toContain('close')

      // A chord invented in this process is a chord taken off the renderer.
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

  // xterm has no clipboard of its own: copy and paste inside a pane are these items.
  it('keeps the edit roles a terminal needs', () => {
    const edit = roles(submenuOf(applicationMenuTemplate({ platform: 'darwin' }), 'Edit'))
    expect(edit).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
  })

  // macOS neither strips the `&` mnemonic nor acts on it.
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

  // ⌘Q has to reach `before-quit` (quitSequence.ts), so the item carries no
  // handler that could get in front of `app.quit()`.
  it('leaves Quit to Electron, so ⌘Q is app.quit() and nothing of its own', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = applicationMenuTemplate({ platform })
      const menu = platform === 'darwin' ? template[0]?.submenu : submenuOf(template, menuName(platform, 'File'))
      const quit = (Array.isArray(menu) ? menu : []).find((item) => item.role === 'quit')
      expect(quit, platform).toEqual({ role: 'quit' })
    }
  })

  it('puts Quit in the File menu where there is no app menu to hold it', () => {
    const template = applicationMenuTemplate({ platform: 'win32' })
    expect(template[0]?.label).toBe(menuName('win32', 'File'))
    expect(roles(submenuOf(template, menuName('win32', 'File')))).toEqual(['quit'])
    expect(roles(submenuOf(template, menuName('win32', 'Window')))).toEqual(['minimize', 'zoom'])
  })

  // Where a Mac user looks for it.
  it('puts Check for Updates under About, above Services', () => {
    const checkForUpdates = vi.fn()
    const template = applicationMenuTemplate({ platform: 'darwin', checkForUpdates })
    const appMenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : []
    const labels = appMenu.map((item) => item.label ?? item.role ?? item.type)

    expect(labels.indexOf('Check for Updates…')).toBe(2)
    expect(labels.indexOf('Check for Updates…')).toBeLessThan(labels.indexOf('services'))
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

  // A menu item that does nothing is worse than one that is absent.
  it('leaves the item out when there is nothing behind it', () => {
    const appMenu = applicationMenuTemplate({ platform: 'darwin' })[0]?.submenu
    const labels = (Array.isArray(appMenu) ? appMenu : []).map((item) => item.label)
    expect(labels).not.toContain('Check for Updates…')
  })

  // Cmd+R takes every pane view with it, silently.
  it('offers reload only against a dev server', () => {
    expect(roles(applicationMenuTemplate({ platform: 'darwin' }))).not.toContain('reload')
    expect(roles(applicationMenuTemplate({ platform: 'darwin', developing: true }))).toContain('reload')
  })

  it('offers the developer tools only when asked to', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(roles(applicationMenuTemplate({ platform })), platform).not.toContain('toggleDevTools')
      expect(roles(applicationMenuTemplate({ platform, devTools: true })), platform).toContain('toggleDevTools')
    }
  })

  it('asks for the developer tools under a dev server or the debug variable, and never otherwise', () => {
    expect(offersDevTools({})).toBe(false)
    expect(offersDevTools({ TEAMREE_DEVTOOLS: '0' })).toBe(false)
    expect(offersDevTools({ ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(true)
    expect(offersDevTools({ TEAMREE_DEVTOOLS: '1' })).toBe(true)
  })
})

describe('the Help menu', () => {
  const opened = (options: Partial<ApplicationMenuOptions['links'] & object> = {}): string[] => {
    const open = vi.fn<(url: string) => void>()
    const template = applicationMenuTemplate({
      platform: 'darwin',
      commands: published(),
      links: { version: '1.2.3', systemVersion: '15.2.0', open, ...options }
    })
    for (const item of submenuOf(template, 'Help')) item.click?.(undefined as never, undefined, undefined as never)
    return open.mock.calls.map(([url]) => url)
  }

  it('lists Shortcuts, then the website, the release notes, the issue form and the star', () => {
    const template = applicationMenuTemplate({
      platform: 'darwin',
      commands: published(),
      links: { version: '1.2.3', systemVersion: '15.2.0', open: () => {} }
    })
    expect(labelsOf(template, 'Help')).toEqual([
      shipped('open-help'),
      '—',
      'teamree Website',
      'Release Notes',
      'Report an Issue',
      'Star on GitHub'
    ])
    expect(shipped('open-help')).toBe('Shortcuts')
    expect(template.find((item) => item.label === 'Help')?.role).toBe('help')
  })

  it('offers Check for Updates… between Shortcuts and the links, and runs the check', () => {
    const checkForUpdates = vi.fn()
    const template = applicationMenuTemplate({
      platform: 'darwin',
      commands: published(),
      checkForUpdates,
      links: { version: '1.2.3', systemVersion: '15.2.0', open: () => {} }
    })
    expect(labelsOf(template, 'Help').slice(0, 4)).toEqual([shipped('open-help'), '—', 'Check for Updates…', '—'])
    submenuOf(template, 'Help')
      .find((item) => item.label === 'Check for Updates…')
      ?.click?.(undefined as never, undefined, undefined as never)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('opens each one in the browser', () => {
    expect(opened()).toEqual([
      'https://teamree.us',
      'https://github.com/zero-abd/teamree/releases/tag/v1.2.3',
      `https://github.com/zero-abd/teamree/issues/new?body=${encodeURIComponent('\n\n---\nteamree 1.2.3\nmacOS 15.2.0\n')}`,
      'https://github.com/zero-abd/teamree'
    ])
  })

  // The body carries the two versions and nothing that names the person or the machine.
  it('prefills the issue with the versions and nothing else', () => {
    const issue = new URL(opened()[2] ?? '')
    expect([...issue.searchParams.keys()]).toEqual(['body'])
    expect(issue.searchParams.get('body')).toBe('\n\n---\nteamree 1.2.3\nmacOS 15.2.0\n')
  })

  // A dev build has no release of its own to show.
  it('sends a dev build to the release list', () => {
    expect(opened({ version: '0.0.0-dev' })[1]).toBe('https://github.com/zero-abd/teamree/releases')
  })

  it('names the platform where it is not macOS', () => {
    const open = vi.fn<(url: string) => void>()
    const template = applicationMenuTemplate({
      platform: 'linux',
      links: { version: '1.2.3', systemVersion: '6.8.0', open }
    })
    submenuOf(template, '&Help')
      .find((item) => item.label === 'Report an Issue')
      ?.click?.(undefined as never, undefined, undefined as never)
    expect(new URL(open.mock.calls[0]?.[0] ?? '').searchParams.get('body')).toContain('linux 6.8.0')
  })

  it('is there before the window has published anything', () => {
    const template = applicationMenuTemplate({
      platform: 'darwin',
      links: { version: '1.2.3', systemVersion: '15.2.0', open: () => {} }
    })
    expect(labelsOf(template, 'Help')).toEqual([
      'teamree Website',
      'Release Notes',
      'Report an Issue',
      'Star on GitHub'
    ])
  })
})

describe('the About panel', () => {
  it('shows the version, a copyright line, the website and the repository', () => {
    expect(aboutPanelOptions('1.2.3')).toEqual({
      applicationName: 'teamree',
      applicationVersion: '1.2.3',
      version: '',
      copyright: 'Copyright © teamree contributors',
      credits: 'https://teamree.us\nhttps://github.com/zero-abd/teamree',
      website: 'https://teamree.us'
    })
    expect(aboutPanelOptions('1.2.3', '/icon.png').iconPath).toBe('/icon.png')
  })
})

describe('the window’s own commands in the menu bar', () => {
  it('reads each published item under the menu it asked for', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })

    const appMenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : []
    expect(appMenu.map((item) => item.label ?? item.role)).toContain('Settings…')

    // In the order the window published them.
    expect(labelsOf(template, 'File')).toEqual(['New Task', 'New Terminal', 'Close Pane'])
    expect(labelsOf(template, 'Edit').slice(-2)).toEqual(['—', 'Find in Pane'])
    expect(labelsOf(template, 'View').slice(0, 3)).toEqual([shipped('open-palette'), shipped('open-appearance'), '—'])
    expect(shipped('open-palette')).toBe('Go to Worktree or Command')
    expect(labelsOf(template, 'Window')).toEqual(['Split Pane Right', '—', 'minimize', 'zoom', '—', 'front'])
    expect(labelsOf(template, 'Help')).toEqual([shipped('open-help')])
  })

  // ⌘+ sizes the text in the panes, as in every terminal; the window itself keeps its size.
  it('puts the text size where the zoom roles were, and no zoom role anywhere', () => {
    const template = applicationMenuTemplate({
      platform: 'darwin',
      commands: { items: menuBarSpec(EMPTY), choose: () => {} }
    })
    for (const role of ['resetZoom', 'zoomIn', 'zoomOut'] as const) expect(roles(template)).not.toContain(role)
    expect(labelsOf(template, 'View').slice(-6)).toEqual([
      '—',
      'Actual Size',
      'Bigger Text',
      'Smaller Text',
      '—',
      'togglefullscreen'
    ])
    const accelerators = Object.fromEntries(items(template).map((item) => [item.label, item.accelerator]))
    expect(accelerators['Bigger Text']).toBe('CommandOrControl+=')
    expect(accelerators['Smaller Text']).toBe('CommandOrControl+-')
    expect(accelerators['Actual Size']).toBe('CommandOrControl+0')
  })

  // The `help` role is what attaches the system's own search field on macOS.
  it('gives the Help menu the role that makes it the platform’s Help menu', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })
    expect(template.find((item) => item.label === 'Help')?.role).toBe('help')
  })

  it('shows exactly the chord the window published, and never one of its own', () => {
    const template = applicationMenuTemplate({ platform: 'darwin', commands: published() })
    for (const item of SPEC) {
      const found = items(template).find((entry) => entry.label === item.label)
      // An empty accelerator becomes none: Electron reads an unparsable string as a fault.
      expect(found?.accelerator, item.command).toBe(item.accelerator === '' ? undefined : item.accelerator)
    }
    expect(shipped('open-appearance')).toBe('Appearance…')
    expect(SPEC.find((item) => item.command === 'open-appearance')?.accelerator).toBe('')
  })

  // Windows and Linux keep the renderer as the single dispatcher; macOS
  // ignores the option and the menu consumes the key, also single dispatch.
  it('asks not to register any of these accelerators with the system', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const template = applicationMenuTemplate({ platform, commands: published() })
      // Bar the item with no chord.
      const commandItems = items(template).filter((item) => item.accelerator !== undefined)
      expect(commandItems.length, platform).toBe(SPEC.filter((item) => item.accelerator !== '').length)
      expect(
        commandItems.every((item) => item.registerAccelerator === false),
        platform
      ).toBe(true)
    }
  })

  // Nothing is offered that cannot work.
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
    const item = items(template).find((entry) => entry.label === 'New Task')

    item?.click?.(undefined as never, undefined, undefined as never)
    expect(choose).toHaveBeenCalledExactlyOnceWith('new-worktree')
  })

  // A row of items with nothing behind them is worse than the roles alone.
  it('offers no command menu at all until the window has published one', () => {
    const template = applicationMenuTemplate({ platform: 'darwin' })
    expect(template.map((item) => item.label)).not.toContain('File')
    expect(template.map((item) => item.label)).not.toContain('Help')
    expect(items(template).every((item) => item.accelerator === undefined)).toBe(true)
  })

  // A window from a build that knows a menu this one does not.
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

  it('folds the application items into File where there is no app menu', () => {
    const template = applicationMenuTemplate({ platform: 'win32', commands: published() })
    expect(labelsOf(template, menuName('win32', 'File'))).toEqual([
      'New Task',
      'New Terminal',
      'Close Pane',
      'Settings…',
      '—',
      'quit'
    ])
  })
})

/** Words macOS title case keeps lowercase between the first and the last. */
const MINOR_WORDS = new Set('a an and as at but by for in nor of on or the to'.split(' '))
/** Names spelt as their owners spell them. */
const PROPER_NAMES = new Set(['teamree'])

/** The words of `label` that break title case; empty when it is title case. */
function titleCaseFaults(label: string): string[] {
  const words = label.replace(/…$/, '').split(/[\s/]+/)
  return words.filter((word, index) => {
    if (PROPER_NAMES.has(word)) return false
    const minor = MINOR_WORDS.has(word.toLowerCase()) && index > 0 && index < words.length - 1
    return minor ? word !== word.toLowerCase() : !/^[\p{Lu}\p{N}]/u.test(word)
  })
}

describe('the menu bar’s wording', () => {
  it('knows title case when it sees it', () => {
    expect(titleCaseFaults('Go to File…')).toEqual([])
    expect(titleCaseFaults('Show/Hide Right Panel')).toEqual([])
    expect(titleCaseFaults('teamree Website')).toEqual([])
    expect(titleCaseFaults('New task')).toEqual(['task'])
    expect(titleCaseFaults('Find In Pane')).toEqual(['In'])
  })

  it('writes every item in title case, with the panels shown and hidden', () => {
    for (const panels of [{}, { sidebarVisible: false, rightPanelOpen: false }]) {
      const template = applicationMenuTemplate({
        platform: 'darwin',
        checkForUpdates: () => {},
        links: { version: '1.2.3', systemVersion: '15.2.0', open: () => {} },
        commands: { items: menuBarSpec({ ...EMPTY, ...panels }), choose: () => {} }
      })
      const labels = items(template).flatMap((item) => (item.label === undefined ? [] : [item.label]))
      expect(labels.length).toBeGreaterThan(40)
      for (const label of labels) expect(titleCaseFaults(label), label).toEqual([])
    }
  })

  // Theme rows carry the preset's own name; the CLI row is the sidebar badge's wording.
  it('writes every palette action in title case too', () => {
    const labels = buildPaletteItems({
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'w1',
          branch: 'w1',
          path: '/w1',
          startedFrom: 'main',
          state: 'ready',
          createdAt: 0
        }
      ],
      projects: [{ id: 'p1', name: 'atlas', path: '/atlas', baseRef: 'origin/main' }],
      activeWorktreeId: 'w1',
      agents: [],
      defaultAgent: '',
      update: null,
      cli: null,
      hintFor: () => '',
      openIn: ['Cursor', 'Terminal'],
      focusedChange: { path: 'a.ts', discardable: true, staged: true }
    })
      .filter((item) => item.kind === 'action' && !item.id.startsWith('theme:') && item.id !== 'install-cli')
      .map((item) => item.label)
    expect(labels).toEqual(expect.arrayContaining(['Show Changes', 'Rename Worktree…', 'Discard File Changes…']))
    for (const label of labels) expect(titleCaseFaults(label), label).toEqual([])
  })
})
