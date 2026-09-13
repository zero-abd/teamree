// xterm needs literal colours, but the palette belongs in CSS. This reads the
// custom properties so the emulator and the chrome around it can never drift
// apart — including when the palette changes under a running terminal, which is
// what makes switching themes reach panes that are already open.
//
// All sixteen ANSI colours are mapped, not the eight the interface happens to
// reuse. An unmapped entry does not go unthemed, it silently keeps xterm's own
// default, which is how a window could end up drawing bright green from one
// palette beside green from another.

import type { ISearchOptions } from '@xterm/addon-search'
import type { ITheme } from '@xterm/xterm'

const FALLBACK: ITheme = {
  background: '#000000',
  foreground: '#e4e7ee',
  cursor: '#9e9ef8',
  cursorAccent: '#000000',
  selectionBackground: '#2f3054',
  black: '#212223',
  red: '#e8615a',
  green: '#57c38a',
  yellow: '#d6a24a',
  blue: '#5aa9e6',
  magenta: '#a98bf0',
  cyan: '#4fb6b2',
  white: '#bbbdc3',
  brightBlack: '#737577',
  brightRed: '#ed847e',
  brightGreen: '#7cd0a4',
  brightYellow: '#dfb672',
  brightBlue: '#7ebcec',
  brightMagenta: '#bca5f3',
  brightCyan: '#76c6c3',
  brightWhite: '#e4e7ee'
}

const VARIABLE_BY_KEY: Partial<Record<keyof ITheme, string>> = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  cursorAccent: '--term-bg',
  selectionBackground: '--term-selection',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white'
}

export function readTerminalTheme(root: Element | null): ITheme {
  if (!root || typeof getComputedStyle !== 'function') return FALLBACK
  const computed = getComputedStyle(root)
  const theme: ITheme = { ...FALLBACK }
  // Every mapped entry is a colour string; ITheme also carries a string[] member.
  const colors = theme as Record<string, string>
  for (const [key, variable] of Object.entries(VARIABLE_BY_KEY)) {
    const value = computed.getPropertyValue(variable).trim()
    if (value) colors[key] = value
  }
  return theme
}

type SearchDecorations = NonNullable<ISearchOptions['decorations']>

/**
 * Search highlights reuse the selection colour, because a match is a selection
 * the user did not have to make by hand. The active one is told apart by an
 * accent border rather than a filled accent background: xterm draws the cell's
 * own text over the decoration, and a bright fill would bury it.
 *
 * The addon parses these itself and only understands #RRGGBB, so every entry
 * must map to a solid hex token.
 */
const SEARCH_VARIABLE_BY_KEY: Record<keyof Required<SearchDecorations>, string> = {
  matchBackground: '--term-selection',
  matchBorder: '--term-bright-black',
  matchOverviewRuler: '--term-bright-black',
  activeMatchBackground: '--term-selection',
  activeMatchBorder: '--accent-bright',
  activeMatchColorOverviewRuler: '--accent-bright'
}

const SEARCH_FALLBACK: Required<SearchDecorations> = {
  matchBackground: '#2f3054',
  matchBorder: '#737577',
  matchOverviewRuler: '#737577',
  activeMatchBackground: '#2f3054',
  activeMatchBorder: '#9e9ef8',
  activeMatchColorOverviewRuler: '#9e9ef8'
}

export function readSearchDecorations(root: Element | null): SearchDecorations {
  if (!root || typeof getComputedStyle !== 'function') return SEARCH_FALLBACK
  const computed = getComputedStyle(root)
  const read = (key: keyof Required<SearchDecorations>): string =>
    computed.getPropertyValue(SEARCH_VARIABLE_BY_KEY[key]).trim() || SEARCH_FALLBACK[key]
  return {
    matchBackground: read('matchBackground'),
    matchBorder: read('matchBorder'),
    matchOverviewRuler: read('matchOverviewRuler'),
    activeMatchBackground: read('activeMatchBackground'),
    activeMatchBorder: read('activeMatchBorder'),
    activeMatchColorOverviewRuler: read('activeMatchColorOverviewRuler')
  }
}

export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace'
