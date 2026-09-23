// Which key means "the app modifier", and how it is spelled to the user. Both
// answers come from one place so a label can never drift from the binding that
// actually fires.

export type PlatformModifier = {
  /** The KeyboardEvent flag that must be set for a chord to count. */
  eventFlag: 'metaKey' | 'ctrlKey'
  /** How the modifier is written in menus and hints. */
  label: string
  shiftLabel: string
  altLabel: string
  controlLabel: string
  /** Apple keyboards stack glyphs; everywhere else the parts are joined. */
  separator: string
}

const APPLE: PlatformModifier = {
  eventFlag: 'metaKey',
  label: '⌘',
  shiftLabel: '⇧',
  altLabel: '⌥',
  controlLabel: '⌃',
  separator: ''
}

const PC: PlatformModifier = {
  eventFlag: 'ctrlKey',
  label: 'Ctrl',
  shiftLabel: 'Shift',
  altLabel: 'Alt',
  controlLabel: 'Ctrl',
  separator: '+'
}

export function resolvePlatformModifier(platform: string | undefined): PlatformModifier {
  return isApplePlatform(platform) ? APPLE : PC
}

export function isApplePlatform(platform: string | undefined): boolean {
  if (!platform) return false
  const value = platform.toLowerCase()
  return value === 'darwin' || value.includes('mac') || value.includes('iphone') || value.includes('ipad')
}

/**
 * Electron hands us `process.platform` through the preload bridge; a plain
 * browser (tests, a stray vite preview) only has a user-agent string.
 */
export function detectPlatform(bridgePlatform?: string, userAgent?: string): string {
  if (bridgePlatform) return bridgePlatform
  if (userAgent) return userAgent
  return 'unknown'
}

export type ModifierState = {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** True when the app modifier is held and the foreign modifier is not. */
export function holdsModifier(event: ModifierState, modifier: PlatformModifier): boolean {
  return modifier.eventFlag === 'metaKey' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export type Chord = {
  /** Compared case-insensitively against KeyboardEvent.key. */
  key: string
  shift?: boolean
  alt?: boolean
  /** Held as Control in place of the app modifier, which on a Mac is a different key. */
  ctrl?: boolean
}

export function matchesChord(
  event: ModifierState & { key: string },
  chord: Chord,
  modifier: PlatformModifier
): boolean {
  const held = chord.ctrl ? event.ctrlKey && !event.metaKey : holdsModifier(event, modifier)
  if (!held) return false
  if (event.shiftKey !== Boolean(chord.shift)) return false
  if (event.altKey !== Boolean(chord.alt)) return false
  return event.key.toLowerCase() === chord.key.toLowerCase()
}

/** Renders a chord the way this platform's users expect to read it. */
export function formatChord(chord: Chord, modifier: PlatformModifier): string {
  const parts = [chord.ctrl ? modifier.controlLabel : modifier.label]
  if (chord.alt) parts.push(modifier.altLabel)
  if (chord.shift) parts.push(modifier.shiftLabel)
  parts.push(formatKeyName(chord.key))
  return parts.join(modifier.separator)
}

function formatKeyName(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  if (key === 'Enter') return '↩'
  if (key === 'ArrowLeft') return '←'
  if (key === 'ArrowRight') return '→'
  if (key === 'ArrowUp') return '↑'
  if (key === 'ArrowDown') return '↓'
  return key
}
