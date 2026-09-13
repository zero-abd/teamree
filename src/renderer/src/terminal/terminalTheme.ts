// xterm needs literal colours, but the palette belongs in CSS. This reads the
// custom properties once per terminal so the emulator and the chrome around it
// can never drift apart.

import type { ISearchOptions } from '@xterm/addon-search'
import type { ITheme } from '@xterm/xterm'

const FALLBACK: ITheme = {
  background: '#0f1116',
  foreground: '#d7dde8',
  cursor: '#8b8cf7',
  cursorAccent: '#0f1116',
  selectionBackground: '#2b3350',
  black: '#1b1f27',
  red: '#e8615a',
  green: '#57c38a',
  yellow: '#d6a24a',
  blue: '#5aa9e6',
  magenta: '#a98bf0',
  cyan: '#4fb6b2',
  white: '#c3cad6',
  brightBlack: '#5c6577',
  brightRed: '#f2827b',
  brightGreen: '#79d8a6',
  brightYellow: '#e8bd6c',
  brightBlue: '#7ec0f5',
  brightMagenta: '#c0a7ff',
  brightCyan: '#6fd0cb',
  brightWhite: '#eef2f8'
}

const VARIABLE_BY_KEY: Partial<Record<keyof ITheme, string>> = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  selectionBackground: '--term-selection',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black'
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
  matchBackground: '#2b3350',
  matchBorder: '#5c6577',
  matchOverviewRuler: '#5c6577',
  activeMatchBackground: '#2b3350',
  activeMatchBorder: '#a6a7ff',
  activeMatchColorOverviewRuler: '#a6a7ff'
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
