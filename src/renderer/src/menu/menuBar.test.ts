// What the menu bar says, and whether it is true: every binding has an item, and every accelerator
// shown, turned back into a keypress, is the chord `commandForEvent` fires.

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

/** `KeyboardEvent.key` for the keys Electron spells differently, from `menuBar.ts`'s table reversed. */
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

  // Derived, so a rebind moves the item's chord with it.
  it('shows the chord that fires, for every one of them', () => {
    // Except items with no chord.
    for (const item of menuBarSpec(WORKING).filter((entry) => entry.accelerator !== '')) {
      expect(commandForEvent(keypressFor(item.accelerator), MAC), item.accelerator).toBe(item.command)
    }
  })

  it('spells a chord the way Electron does', () => {
    expect(acceleratorForChord({ key: 'd' })).toBe('CommandOrControl+D')
    expect(acceleratorForChord({ key: 'd', shift: true })).toBe('CommandOrControl+Shift+D')
    expect(acceleratorForChord({ key: 'd', alt: true, shift: true })).toBe('CommandOrControl+Alt+Shift+D')
    expect(acceleratorForChord({ key: ',' })).toBe('CommandOrControl+,')
    expect(acceleratorForChord({ key: '/' })).toBe('CommandOrControl+/')
    expect(acceleratorForChord({ key: ']' })).toBe('CommandOrControl+]')
    // The arrows are where Electron's key names differ from the browser's; a mistake is silent.
    expect(acceleratorForChord({ key: 'ArrowUp', alt: true })).toBe('CommandOrControl+Alt+Up')
    expect(acceleratorForChord({ key: 'ArrowDown', alt: true })).toBe('CommandOrControl+Alt+Down')
    expect(acceleratorForChord({ key: 'Enter', shift: true })).toBe('CommandOrControl+Shift+Enter')
    expect(acceleratorForChord({ key: '=' })).toBe('CommandOrControl+=')
    expect(acceleratorForChord({ key: '-' })).toBe('CommandOrControl+-')
    expect(acceleratorForChord({ key: '0' })).toBe('CommandOrControl+0')
  })

  // Labels come from the table too: one wording per command.
  it('calls each command what the table calls it', () => {
    const spec = menuBarSpec(WORKING)
    // The platform's wording; tested below.
    const platformNames: string[] = ['open-settings', 'open-appearance']
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      if (platformNames.includes(shortcut.command)) continue
      expect(spec.find((item) => item.command === shortcut.command)?.label, shortcut.command).toBe(shortcut.title)
    }
  })

  // Menu order, not table order: "New task, New terminal, Close pane".
  it('puts the items of a menu in the order they are read', () => {
    const sectionOrder = (section: string): string[] =>
      menuBarSpec(WORKING)
        .filter((item) => item.section === section)
        .map((item) => item.command)

    expect(sectionOrder('file')).toEqual([
      'new-worktree',
      'new-terminal',
      'new-markdown',
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
    expect(sectionOrder('text')).toEqual(['actual-size', 'bigger-text', 'smaller-text'])
    expect(sectionOrder('edit')).toEqual(['find-in-pane'])
    expect(sectionOrder('help')).toEqual(['open-help'])
  })

  // Every section name must be one main actually builds, or the item is never seen.
  it('reads every item under one of the menus that exist', () => {
    const menus = ['application', 'file', 'edit', 'view', 'text', 'window', 'help']
    for (const item of menuBarSpec(WORKING)) expect(menus, item.command).toContain(item.section)
  })
})

describe('what the menu bar says can be done', () => {
  // Nothing offered that cannot work: a first launch greys what has nothing to act on.
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
      'new-markdown': false,
      'new-worktree': false,
      'commit-changes': false,
      'push-worktree': false,
      'toggle-sidebar': true,
      'toggle-right-panel': false,
      'open-palette': true,
      'open-dashboard': true,
      'open-appearance': true,
      'open-settings': true,
      'open-help': true,
      'bigger-text': true,
      'smaller-text': true,
      'actual-size': false
    })
  })

  it('lights them once there is a worktree open with a pane in it', () => {
    // All but the walks (one pane, one worktree: nowhere to go), the git pair (no status read yet) and
    // Actual Size (already there).
    const nowhere = [
      'actual-size',
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

// ⌘, and `Settings…` reach the settings page; the theme editor has its own item.
describe('the two settings surfaces are two items', () => {
  it('opens the settings page from Settings…, in the application menu', () => {
    const item = menuBarSpec(WORKING).find((entry) => entry.command === 'open-settings')
    expect(item?.label).toBe('Settings…')
    expect(item?.section).toBe('application')
    expect(item?.accelerator).toBe('CommandOrControl+,')
  })

  // No chord: shift+comma yields `<`, so ⌘⇧, cannot be bound.
  it('gives the theme editor its own item under View, with no chord', () => {
    const item = menuBarSpec(WORKING).find((entry) => entry.command === 'open-appearance')
    expect(item?.label).toBe('Appearance…')
    expect(item?.section).toBe('view')
    expect(item?.accelerator).toBe('')
  })
})
