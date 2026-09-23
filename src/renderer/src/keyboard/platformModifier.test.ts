import { describe, expect, it } from 'vitest'
import {
  detectPlatform,
  formatChord,
  holdsModifier,
  isApplePlatform,
  matchesChord,
  resolvePlatformModifier
} from './platformModifier'
import {
  commandForEvent,
  commandNamed,
  paneNumberForEvent,
  shortcutHint,
  WORKSPACE_SHORTCUTS
} from './workspaceShortcuts'

const mac = resolvePlatformModifier('darwin')
const pc = resolvePlatformModifier('win32')

const event = (
  overrides: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>
) => ({
  key: 'd',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides
})

describe('resolvePlatformModifier', () => {
  it('uses command on macOS', () => {
    expect(mac.eventFlag).toBe('metaKey')
    expect(mac.label).toBe('⌘')
  })

  it('uses control everywhere else', () => {
    expect(pc.eventFlag).toBe('ctrlKey')
    expect(resolvePlatformModifier('linux').eventFlag).toBe('ctrlKey')
    expect(resolvePlatformModifier(undefined).eventFlag).toBe('ctrlKey')
  })

  it('recognises apple platforms from a user agent too', () => {
    expect(isApplePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true)
    expect(isApplePlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe(false)
  })
})

describe('detectPlatform', () => {
  it('prefers what the preload bridge reports', () => {
    expect(detectPlatform('darwin', 'Windows NT')).toBe('darwin')
  })

  it('falls back to the user agent, then to unknown', () => {
    expect(detectPlatform(undefined, 'Macintosh')).toBe('Macintosh')
    expect(detectPlatform(undefined, undefined)).toBe('unknown')
  })
})

describe('holdsModifier', () => {
  it('accepts only its own modifier', () => {
    expect(holdsModifier(event({ metaKey: true }), mac)).toBe(true)
    expect(holdsModifier(event({ ctrlKey: true }), mac)).toBe(false)
    expect(holdsModifier(event({ ctrlKey: true }), pc)).toBe(true)
    expect(holdsModifier(event({ metaKey: true }), pc)).toBe(false)
  })

  it('rejects the two held together, which is a different chord', () => {
    expect(holdsModifier(event({ metaKey: true, ctrlKey: true }), mac)).toBe(false)
    expect(holdsModifier(event({ metaKey: true, ctrlKey: true }), pc)).toBe(false)
  })
})

describe('matchesChord', () => {
  it('ignores the case of the typed key', () => {
    expect(matchesChord(event({ key: 'D', metaKey: true }), { key: 'd' }, mac)).toBe(true)
  })

  it('treats shift as part of the chord, not a decoration', () => {
    expect(matchesChord(event({ metaKey: true, shiftKey: true }), { key: 'd' }, mac)).toBe(false)
    expect(matchesChord(event({ metaKey: true, shiftKey: true }), { key: 'd', shift: true }, mac)).toBe(true)
  })

  // ⌃Tab is Control on a Mac too, where Control is not the app modifier.
  it('reads a control chord as Control on every platform', () => {
    const chord = { key: 'Tab', ctrl: true }
    expect(matchesChord(event({ key: 'Tab', ctrlKey: true }), chord, mac)).toBe(true)
    expect(matchesChord(event({ key: 'Tab', metaKey: true }), chord, mac)).toBe(false)
    expect(matchesChord(event({ key: 'Tab', ctrlKey: true, metaKey: true }), chord, mac)).toBe(false)
    expect(matchesChord(event({ key: 'Tab', ctrlKey: true }), chord, pc)).toBe(true)
  })

  it('reads a bare chord as the key with no modifier but shift', () => {
    const chord = { key: 'F6', bare: true }
    expect(matchesChord(event({ key: 'F6' }), chord, mac)).toBe(true)
    expect(matchesChord(event({ key: 'F6' }), chord, pc)).toBe(true)
    expect(matchesChord(event({ key: 'F6', metaKey: true }), chord, mac)).toBe(false)
    expect(matchesChord(event({ key: 'F6', ctrlKey: true }), chord, pc)).toBe(false)
    expect(matchesChord(event({ key: 'F6', shiftKey: true }), chord, mac)).toBe(false)
    expect(matchesChord(event({ key: 'F6', shiftKey: true }), { ...chord, shift: true }, mac)).toBe(true)
  })
})

describe('formatChord', () => {
  it('stacks glyphs on macOS', () => {
    expect(formatChord({ key: 'd' }, mac)).toBe('⌘D')
    expect(formatChord({ key: 'd', shift: true }, mac)).toBe('⌘⇧D')
  })

  it('joins the parts elsewhere', () => {
    expect(formatChord({ key: 'd' }, pc)).toBe('Ctrl+D')
    expect(formatChord({ key: 'd', shift: true }, pc)).toBe('Ctrl+Shift+D')
  })

  it('draws Control as Control', () => {
    expect(formatChord({ key: 'Tab', ctrl: true }, mac)).toBe('⌃Tab')
    expect(formatChord({ key: 'Tab', ctrl: true, shift: true }, mac)).toBe('⌃⇧Tab')
    expect(formatChord({ key: 'Tab', ctrl: true, shift: true }, pc)).toBe('Ctrl+Shift+Tab')
  })

  it('draws a bare chord as its key', () => {
    expect(formatChord({ key: 'F6', bare: true }, mac)).toBe('F6')
    expect(formatChord({ key: 'F6', bare: true, shift: true }, mac)).toBe('⇧F6')
    expect(formatChord({ key: 'F6', bare: true, shift: true }, pc)).toBe('Shift+F6')
  })

  // A key whose name is a word is drawn as the glyph on the keycap. `ArrowUp`
  // printed in a menu beside "Previous worktree" is the browser's word for a
  // key, offered to somebody looking for an arrow.
  it('draws the named keys as the marks on the keys', () => {
    expect(formatChord({ key: 'ArrowUp', alt: true }, mac)).toBe('⌘⌥↑')
    expect(formatChord({ key: 'ArrowDown', alt: true }, mac)).toBe('⌘⌥↓')
    expect(formatChord({ key: 'Enter', shift: true }, mac)).toBe('⌘⇧↩')
    expect(formatChord({ key: 'ArrowUp', alt: true }, pc)).toBe('Ctrl+Alt+↑')
  })
})

describe('workspace shortcuts', () => {
  it('routes each chord to exactly one command', () => {
    expect(commandForEvent(event({ key: 'd', metaKey: true }), mac)).toBe('split-right')
    expect(commandForEvent(event({ key: 'd', metaKey: true, shiftKey: true }), mac)).toBe('split-down')
    expect(commandForEvent(event({ key: 'w', metaKey: true }), mac)).toBe('close-pane')
    expect(commandForEvent(event({ key: 'd', ctrlKey: true }), pc)).toBe('split-right')
    expect(commandForEvent(event({ key: 'e', metaKey: true }), mac)).toBe('open-dashboard')
    // The four moves, by the `KeyboardEvent.key` each of them really arrives
    // as: the brackets unshifted, because shift and a bracket is a brace and a
    // different key name entirely, and the arrows spelled the browser's way.
    expect(commandForEvent(event({ key: '[', metaKey: true }), mac)).toBe('focus-previous-pane')
    expect(commandForEvent(event({ key: ']', metaKey: true }), mac)).toBe('focus-next-pane')
    expect(commandForEvent(event({ key: 'Enter', metaKey: true, shiftKey: true }), mac)).toBe('expand-pane')
    expect(commandForEvent(event({ key: 'ArrowUp', metaKey: true, altKey: true }), mac)).toBe('previous-worktree')
    expect(commandForEvent(event({ key: 'ArrowDown', metaKey: true, altKey: true }), mac)).toBe('next-worktree')
    // And without alt they are nobody's: ⌘↑ and ⌘↓ belong to whatever is
    // running in the pane.
    expect(commandForEvent(event({ key: 'ArrowUp', metaKey: true }), mac)).toBeNull()
  })

  // ⌘+ is shift and = on a US keyboard and its own key elsewhere; both arrive as `+`.
  it('reads ⌘=, ⌘+, ⌘− and ⌘0 as the text size', () => {
    expect(commandForEvent(event({ key: '=', metaKey: true }), mac)).toBe('bigger-text')
    expect(commandForEvent(event({ key: '+', metaKey: true, shiftKey: true }), mac)).toBe('bigger-text')
    expect(commandForEvent(event({ key: '+', metaKey: true }), mac)).toBe('bigger-text')
    expect(commandForEvent(event({ key: '-', metaKey: true }), mac)).toBe('smaller-text')
    expect(commandForEvent(event({ key: '0', metaKey: true }), mac)).toBe('actual-size')
    expect(commandForEvent(event({ key: '=', ctrlKey: true }), pc)).toBe('bigger-text')
    expect(commandForEvent(event({ key: '+', metaKey: true, altKey: true }), mac)).toBeNull()
  })

  // Every tabbed macOS app; the terminal apps too.
  it('reads ⌃Tab and ⌃⇧Tab as the tab walk, and ⌘Tab as nothing', () => {
    expect(commandForEvent(event({ key: 'Tab', ctrlKey: true }), mac)).toBe('select-next-pane')
    expect(commandForEvent(event({ key: 'Tab', ctrlKey: true, shiftKey: true }), mac)).toBe('select-previous-pane')
    expect(commandForEvent(event({ key: 'Tab', ctrlKey: true }), pc)).toBe('select-next-pane')
    expect(commandForEvent(event({ key: 'Tab', metaKey: true }), mac)).toBeNull()
    expect(commandForEvent(event({ key: 'Tab' }), mac)).toBeNull()
  })

  // As in every Mac app with panes, and the editors run in them.
  it('reads F6 and ⇧F6 as the region walk, alone', () => {
    expect(commandForEvent(event({ key: 'F6' }), mac)).toBe('focus-next-region')
    expect(commandForEvent(event({ key: 'F6', shiftKey: true }), mac)).toBe('focus-previous-region')
    expect(commandForEvent(event({ key: 'F6' }), pc)).toBe('focus-next-region')
    expect(commandForEvent(event({ key: 'F6', metaKey: true }), mac)).toBeNull()
    expect(shortcutHint('focus-next-region', mac)).toBe('F6')
    expect(shortcutHint('focus-previous-region', mac)).toBe('⇧F6')
  })

  it('reads ⌘1–⌘9 as a tab number, and nothing else as one', () => {
    for (const digit of [1, 2, 8, 9]) {
      expect(paneNumberForEvent(event({ key: String(digit), metaKey: true }), mac)).toBe(digit)
    }
    expect(paneNumberForEvent(event({ key: '3', ctrlKey: true }), pc)).toBe(3)
    expect(paneNumberForEvent(event({ key: '0', metaKey: true }), mac)).toBeNull()
    expect(paneNumberForEvent(event({ key: '3', ctrlKey: true }), mac)).toBeNull()
    expect(paneNumberForEvent(event({ key: '3', metaKey: true, altKey: true }), mac)).toBeNull()
    expect(paneNumberForEvent(event({ key: '3', metaKey: true, shiftKey: true }), mac)).toBeNull()
    expect(paneNumberForEvent(event({ key: '3' }), mac)).toBeNull()
  })

  // The digits live outside the table, so the table must leave them free.
  it('binds nothing in the table to a tab number', () => {
    for (const digit of '123456789') {
      expect(commandForEvent(event({ key: digit, metaKey: true }), mac), digit).toBeNull()
    }
  })

  it('claims nothing without the modifier', () => {
    expect(commandForEvent(event({ key: 'd' }), mac)).toBeNull()
    expect(commandForEvent(event({ key: 'd', ctrlKey: true }), mac)).toBeNull()
  })

  // Over the entries that have a chord. A command in the table with none is not
  // a binding that collides with anything — it is a command reachable from the
  // menu bar and the palette and from no key at all.
  it('has no duplicate bindings', () => {
    const seen = WORKSPACE_SHORTCUTS.filter((shortcut) => shortcut.chord !== undefined).map(
      (shortcut) =>
        `${shortcut.chord?.key}:${Boolean(shortcut.chord?.bare)}:${Boolean(shortcut.chord?.ctrl)}:${Boolean(shortcut.chord?.shift)}:${Boolean(shortcut.chord?.alt)}`
    )
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBeGreaterThan(5)
  })

  it('answers with no chord for a command that has none', () => {
    expect(shortcutHint('open-appearance', mac)).toBe('')
    expect(shortcutHint('open-settings', mac)).toBe('⌘,')
  })

  it('labels commands with the platform spelling', () => {
    expect(shortcutHint('close-pane', mac)).toBe('⌘W')
    expect(shortcutHint('close-pane', pc)).toBe('Ctrl+W')
    expect(shortcutHint('previous-worktree', mac)).toBe('⌘⌥↑')
    expect(shortcutHint('next-worktree', mac)).toBe('⌘⌥↓')
    expect(shortcutHint('focus-previous-pane', mac)).toBe('⌘[')
    expect(shortcutHint('expand-pane', mac)).toBe('⌘⇧↩')
    expect(shortcutHint('select-next-pane', mac)).toBe('⌃Tab')
    expect(shortcutHint('select-previous-pane', pc)).toBe('Ctrl+Shift+Tab')
  })

  // The menu bar sends a command's name back from the main process, so a
  // string now has to be turned into a command somewhere. The table is what
  // decides, and it decides by refusing anything it does not have rather than
  // by trusting where the string came from.
  it('recognises the commands it has, and only those', () => {
    expect(commandNamed('close-pane')).toBe('close-pane')
    expect(commandNamed('open-help')).toBe('open-help')
    expect(commandNamed('close-window')).toBeNull()
    expect(commandNamed('')).toBeNull()
    // Not a command: a field of the table's own entries, which is the shape of
    // mistake a looser check would let through.
    expect(commandNamed('title')).toBeNull()
  })
})
