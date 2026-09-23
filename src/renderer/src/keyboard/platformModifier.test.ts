import { describe, expect, it } from 'vitest'
import {
  detectPlatform,
  formatChord,
  holdsModifier,
  isApplePlatform,
  matchesChord,
  resolvePlatformModifier
} from './platformModifier'
import { commandForEvent, commandNamed, shortcutHint, WORKSPACE_SHORTCUTS } from './workspaceShortcuts'

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
})

describe('workspace shortcuts', () => {
  it('routes each chord to exactly one command', () => {
    expect(commandForEvent(event({ key: 'd', metaKey: true }), mac)).toBe('split-right')
    expect(commandForEvent(event({ key: 'd', metaKey: true, shiftKey: true }), mac)).toBe('split-down')
    expect(commandForEvent(event({ key: 'w', metaKey: true }), mac)).toBe('close-pane')
    expect(commandForEvent(event({ key: 'd', ctrlKey: true }), pc)).toBe('split-right')
    expect(commandForEvent(event({ key: 'e', metaKey: true }), mac)).toBe('open-dashboard')
  })

  it('claims nothing without the modifier', () => {
    expect(commandForEvent(event({ key: 'd' }), mac)).toBeNull()
    expect(commandForEvent(event({ key: 'd', ctrlKey: true }), mac)).toBeNull()
  })

  it('has no duplicate bindings', () => {
    const seen = WORKSPACE_SHORTCUTS.map(
      (shortcut) => `${shortcut.chord.key}:${Boolean(shortcut.chord.shift)}:${Boolean(shortcut.chord.alt)}`
    )
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('labels commands with the platform spelling', () => {
    expect(shortcutHint('close-pane', mac)).toBe('⌘W')
    expect(shortcutHint('close-pane', pc)).toBe('Ctrl+W')
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
