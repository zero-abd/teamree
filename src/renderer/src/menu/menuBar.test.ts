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
import { isCommandAvailable } from '../keyboard/workspaceCommands'
import { commandForEvent, WORKSPACE_SHORTCUTS } from '../keyboard/workspaceShortcuts'
import { acceleratorForChord, menuBarSpec } from './menuBar'

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
  focusedWatchId: null
}

/** A window with a project, an open worktree and a pane with the focus in it. */
const WORKING: CommandState = {
  ...EMPTY,
  projects: [{ id: 'p1' }],
  worktrees: [{ id: 'w1', projectId: 'p1' }],
  activeWorktreeId: 'w1',
  layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
}

/** The keypress an accelerator stands for, read back out of its own spelling. */
function keypressFor(accelerator: string): ModifierState & { key: string } {
  const parts = accelerator.split('+')
  return {
    key: parts[parts.length - 1] ?? '',
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
    for (const item of menuBarSpec(WORKING)) {
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
  })

  // Labels come from the table too, so there is one wording of a command in the
  // window rather than one for the menu and another for the help page.
  it('calls each command what the table calls it', () => {
    const spec = menuBarSpec(WORKING)
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      if (shortcut.command === 'open-appearance') continue
      expect(spec.find((item) => item.command === shortcut.command)?.label, shortcut.command).toBe(shortcut.title)
    }
  })

  // The one exception, and it is the platform's word rather than this app's:
  // macOS keeps an app's settings in the menu named after the app and calls the
  // item Settings…, and an item called anything else there is one Mac users do
  // not find.
  it('calls the appearance command Settings…, in the application menu', () => {
    const item = menuBarSpec(WORKING).find((entry) => entry.command === 'open-appearance')
    expect(item?.label).toBe('Settings…')
    expect(item?.section).toBe('application')
  })

  // A File menu is read top to bottom and "New task, New terminal, Close pane"
  // is one; the shortcut table's own order would have made it "Close pane, New
  // terminal, New task", which is a list of bindings rather than a menu.
  it('puts the items of a menu in the order they are read', () => {
    const sectionOrder = (section: string): string[] =>
      menuBarSpec(WORKING)
        .filter((item) => item.section === section)
        .map((item) => item.command)

    expect(sectionOrder('file')).toEqual(['new-worktree', 'new-terminal', 'close-pane'])
    expect(sectionOrder('view')).toEqual(['open-palette', 'open-dashboard', 'toggle-sidebar'])
    expect(sectionOrder('window')).toEqual(['split-right', 'split-down', 'focus-next-pane'])
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
      'new-terminal': false,
      'new-worktree': false,
      'toggle-sidebar': true,
      'open-palette': true,
      'open-dashboard': true,
      'open-appearance': true,
      'open-help': true
    })
  })

  it('lights them once there is a worktree open with a pane in it', () => {
    for (const item of menuBarSpec(WORKING)) expect(item.enabled, item.command).toBe(true)
  })

  // One predicate, read by the menu and by the key handler, so a live item and
  // a working chord cannot come apart. Stated as an identity rather than
  // case by case, because a second copy of the reasoning is the thing this is
  // guarding against.
  it('says exactly what the key handler would refuse on', () => {
    for (const state of [EMPTY, WORKING, { ...WORKING, dialog: { kind: 'appearance' } as const }]) {
      for (const item of menuBarSpec(state)) {
        expect(item.enabled, item.command).toBe(isCommandAvailable(item.command, state))
      }
    }
  })
})
