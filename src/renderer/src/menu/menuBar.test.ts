// What the menu bar says, and whether it is telling the truth.
//
// Two claims matter here and everything else is arrangement. The first is that
// no command is missing: the menu is built by walking the same table the key
// handler reads, so a binding that exists has an item. The second is that every
// chord printed beside an item is the chord that actually fires — asserted by
// taking the accelerator the menu would display, turning it back into a
// keypress, and handing that to `commandForEvent`. An accelerator shown in a
// menu that disagrees with the binding is worse than no menu item at all: it is
// a wrong answer given confidently to somebody who came to the menu precisely
// because they did not know.

import { describe, expect, it } from 'vitest'
import type { ModifierState } from '../keyboard/platformModifier'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import type { CommandState } from '../keyboard/workspaceCommands'
import { commandForEvent, WORKSPACE_SHORTCUTS } from '../keyboard/workspaceShortcuts'
import { ACCELERATOR_KEY_NAMES, acceleratorForChord, menuBarSpec } from './menuBar'

const MAC = resolvePlatformModifier('darwin')

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

/** A window with a project, an open worktree and a pane with the focus in it. */
const WORKING: CommandState = {
  ...EMPTY,
  projects: [{ id: 'p1' }],
  worktrees: [{ id: 'w1', projectId: 'p1' }],
  activeWorktreeId: 'w1',
  layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
}

/**
 * `KeyboardEvent.key` for the key Electron spells this way, for the two names
 * that differ. Built by turning the table in `menuBar.ts` round rather than by
 * listing them again: this is the round trip, and a second hand-written copy of
 * the mapping would be a round trip through itself.
 */
const EVENT_KEY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(ACCELERATOR_KEY_NAMES).map(([key, name]) => [name, key])
)

/** The keypress an accelerator stands for, read back out of its own spelling. */
function keypressFor(accelerator: string): ModifierState & { key: string } {
  const parts = accelerator.split('+')
  const key = parts[parts.length - 1] ?? ''
  return {
    key: EVENT_KEY_NAMES[key] ?? key,
    metaKey: parts.includes('CommandOrControl'),
    ctrlKey: false,
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt')
  }
}

describe('the menu bar is built from the table the keyboard reads', () => {
  it('offers every binding there is, once each', () => {
    const spec = menuBarSpec(WORKING)
    expect(spec.map((item) => item.command).sort()).toEqual(WORKSPACE_SHORTCUTS.map((s) => s.command).sort())
  })

  // The whole reason the menu is derived rather than written: a rebind moves
  // the item's chord with it, and cannot leave the menu advertising the old one.
  it('shows the chord that fires, for every one of them', () => {
    // Bar the items with no chord at all, which draw with nothing beside them
    // rather than with a key that does nothing.
    for (const item of menuBarSpec(WORKING).filter((entry) => entry.accelerator !== '')) {
      expect(commandForEvent(keypressFor(item.accelerator), MAC), item.accelerator).toBe(item.command)
    }
  })

  it('spells a chord the way Electron does', () => {
    expect(acceleratorForChord({ key: 'd' })).toBe('CommandOrControl+D')
    expect(acceleratorForChord({ key: 'd', shift: true })).toBe('CommandOrControl+Shift+D')
    expect(acceleratorForChord({ key: 'd', alt: true, shift: true })).toBe('CommandOrControl+Alt+Shift+D')
    // Punctuation is its own key code, and is not uppercased into something
    // else on the way.
    expect(acceleratorForChord({ key: ',' })).toBe('CommandOrControl+,')
    expect(acceleratorForChord({ key: '/' })).toBe('CommandOrControl+/')
    expect(acceleratorForChord({ key: ']' })).toBe('CommandOrControl+]')
    // The arrows are the one place Electron's name for a key is not the
    // browser's. Getting this wrong is silent: the item draws, and the chord
    // beside it is one nothing can press.
    expect(acceleratorForChord({ key: 'ArrowUp', alt: true })).toBe('CommandOrControl+Alt+Up')
    expect(acceleratorForChord({ key: 'ArrowDown', alt: true })).toBe('CommandOrControl+Alt+Down')
    // Return is already spelled the same in both, so it goes through whole.
    expect(acceleratorForChord({ key: 'Enter', shift: true })).toBe('CommandOrControl+Shift+Enter')
  })

  // Labels come from the table too, so there is one wording of a command in the
  // window rather than one for the menu and another for the help page.
  it('calls each command what the table calls it', () => {
    const spec = menuBarSpec(WORKING)
    // The two exceptions are the platform's wording rather than this app's, and
    // they have their own test below.
    const platformNames: string[] = ['open-settings', 'open-appearance']
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      if (platformNames.includes(shortcut.command)) continue
      expect(spec.find((item) => item.command === shortcut.command)?.label, shortcut.command).toBe(shortcut.title)
    }
  })

  // A File menu is read top to bottom and "New task, New terminal, Close pane"
  // is one; the shortcut table's own order would have made it "Close pane, New
  // terminal, New task", which is a list of bindings rather than a menu.
  it('puts the items of a menu in the order they are read', () => {
    const sectionOrder = (section: string): string[] =>
      menuBarSpec(WORKING)
        .filter((item) => item.section === section)
        .map((item) => item.command)

    expect(sectionOrder('file')).toEqual([
      'new-worktree',
      'new-terminal',
      'close-pane',
      'commit-changes',
      'push-worktree'
    ])
    expect(sectionOrder('application')).toEqual(['open-settings'])
    expect(sectionOrder('view')).toEqual([
      'open-palette',
      'previous-worktree',
      'next-worktree',
      'open-dashboard',
      'toggle-sidebar',
      'toggle-right-panel',
      'open-appearance'
    ])
    expect(sectionOrder('window')).toEqual([
      'split-right',
      'split-down',
      'focus-previous-pane',
      'focus-next-pane',
      'expand-pane'
    ])
    expect(sectionOrder('edit')).toEqual(['find-in-pane'])
    expect(sectionOrder('help')).toEqual(['open-help'])
  })

  // Every command lands in a menu somebody would look in. The record that says
  // where is total over the command union, so this cannot be forgotten for a
  // new binding — but nothing stops a section name being misspelled, and an
  // item read under a menu the main process does not have is an item nobody
  // sees.
  it('reads every item under one of the menus that exist', () => {
    const menus = ['application', 'file', 'edit', 'view', 'window', 'help']
    for (const item of menuBarSpec(WORKING)) expect(menus, item.command).toContain(item.section)
  })
})

describe('what the menu bar says can be done', () => {
  // The standing rule: nothing offered that cannot work. On a first launch
  // there is no pane to split, nothing to find in, no terminal to open and no
  // project to make a task in — and the menu says so rather than letting all
  // twelve be pressed for nothing.
  it('greys the pane commands in a window with no panes', () => {
    const enabled = Object.fromEntries(menuBarSpec(EMPTY).map((item) => [item.command, item.enabled]))
    expect(enabled).toEqual({
      'split-right': false,
      'split-down': false,
      'close-pane': false,
      'find-in-pane': false,
      'focus-next-pane': false,
      'focus-previous-pane': false,
      'expand-pane': false,
      'previous-worktree': false,
      'next-worktree': false,
      'new-terminal': false,
      'new-worktree': false,
      // Nothing to commit and nothing to send, in a window with no worktree in
      // it at all.
      'commit-changes': false,
      'push-worktree': false,
      'toggle-sidebar': true,
      'toggle-right-panel': false,
      'open-palette': true,
      'open-dashboard': true,
      'open-appearance': true,
      'open-settings': true,
      'open-help': true
    })
  })

  it('lights them once there is a worktree open with a pane in it', () => {
    // All but the walks, which with one pane and one worktree have nowhere to
    // go — a chord that lands where it started is one this app does not offer.
    // And the two git ones, which need git to have said there is something to
    // do — this window's worktree has no status read at all.
    const nowhere = [
      'focus-next-pane',
      'focus-previous-pane',
      'previous-worktree',
      'next-worktree',
      'commit-changes',
      'push-worktree'
    ]
    for (const item of menuBarSpec(WORKING)) {
      expect(item.enabled, item.command).toBe(!nowhere.includes(item.command))
    }
  })
})

// The Mac reflex, and until now it landed on a colour picker. ⌘, and the item
// the platform names `Settings…` have to reach the page that carries the CLI
// link, the update preference, the terminal text size and the relay; the theme
// editor is a different surface and gets an item of its own.
describe('the two settings surfaces are two items', () => {
  it('opens the settings page from Settings…, in the application menu', () => {
    const item = menuBarSpec(WORKING).find((entry) => entry.command === 'open-settings')
    expect(item?.label).toBe('Settings…')
    expect(item?.section).toBe('application')
    expect(item?.accelerator).toBe('CommandOrControl+,')
  })

  // No chord: ⌘, is the settings page's now, and ⌘⇧, is not a chord this window
  // can bind — `matchesChord` compares `KeyboardEvent.key`, and shift and a
  // comma produce `<`. An item with no accelerator is honest; one advertising a
  // key that never fires is not.
  it('gives the theme editor its own item under View, with no chord', () => {
    const item = menuBarSpec(WORKING).find((entry) => entry.command === 'open-appearance')
    expect(item?.label).toBe('Appearance…')
    expect(item?.section).toBe('view')
    expect(item?.accelerator).toBe('')
  })
})
