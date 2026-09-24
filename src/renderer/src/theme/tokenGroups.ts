// What each colour token is for, in an editor's words, grouped by what moves together; within a group,
// declaration order, ground first, so editing top to bottom goes back to front.

import { THEME_TOKENS, type ThemeToken } from '@shared/theme'

export type TokenGroup = {
  title: string
  tokens: readonly { token: ThemeToken; label: string; about: string }[]
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    title: 'Surfaces',
    tokens: [
      { token: 'bg-window', label: 'Window', about: 'Ground and terminal background' },
      { token: 'bg-rail', label: 'Rail', about: 'Sidebar, pane strip, status bar' },
      { token: 'bg-panel', label: 'Panel', about: 'Pane headers, tab strips, changes list' },
      { token: 'bg-raised', label: 'Raised', about: 'Dialogs, palette, buttons, pop-ups' },
      { token: 'bg-input', label: 'Field', about: 'Text field fill' },
      { token: 'bg-hover', label: 'Hover', about: 'Row under the pointer' },
      { token: 'bg-press', label: 'Press', about: 'Row while held' },
      { token: 'scrim', label: 'Scrim', about: 'Behind an open dialog' }
    ]
  },
  {
    title: 'Lines',
    tokens: [
      { token: 'line', label: 'Hairline', about: 'Borders between regions' },
      { token: 'line-strong', label: 'Strong line', about: 'Button and field borders, key caps' }
    ]
  },
  {
    title: 'Text',
    tokens: [
      { token: 'fg', label: 'Text', about: 'Worktree names, dialog text, terminal output' },
      { token: 'fg-secondary', label: 'Secondary', about: 'Field labels, notices, the rail' },
      { token: 'fg-muted', label: 'Muted', about: 'Branches, counts, timestamps, hints' }
    ]
  },
  {
    title: 'Accent',
    tokens: [
      { token: 'accent', label: 'Accent', about: 'Active marker, primary button, wordmark dot' },
      { token: 'accent-bright', label: 'Accent text', about: 'Accent as text' },
      { token: 'accent-soft', label: 'Accent wash', about: 'Selected row tint' },
      { token: 'accent-line', label: 'Accent line', about: 'Focused field border, focus ring' },
      { token: 'on-accent', label: 'On accent', about: 'Label on an accent button' }
    ]
  },
  {
    title: 'Status',
    tokens: [
      { token: 'success', label: 'Success', about: 'Finished pane' },
      { token: 'warning', label: 'Asking', about: 'An agent waiting on you' },
      { token: 'danger', label: 'Danger', about: 'Conflicts, failures, destructive button' },
      { token: 'info', label: 'Info', about: 'Non-error notice' }
    ]
  },
  {
    title: 'Terminal',
    tokens: [
      { token: 'term-bg', label: 'Background', about: 'Pane background' },
      { token: 'term-fg', label: 'Foreground', about: 'Uncoloured output' },
      { token: 'term-cursor', label: 'Cursor', about: 'Focused pane cursor' },
      { token: 'term-selection', label: 'Selection', about: 'Selection and search matches' },
      { token: 'term-black', label: 'Black', about: 'ANSI 0' },
      { token: 'term-red', label: 'Red', about: 'ANSI 1 · failing tests' },
      { token: 'term-green', label: 'Green', about: 'ANSI 2 · passing tests' },
      { token: 'term-yellow', label: 'Yellow', about: 'ANSI 3 · build warnings' },
      { token: 'term-blue', label: 'Blue', about: 'ANSI 4 · paths and links' },
      { token: 'term-magenta', label: 'Magenta', about: 'ANSI 5 · prompts, diff headers' },
      { token: 'term-cyan', label: 'Cyan', about: 'ANSI 6 · diff headers' },
      { token: 'term-white', label: 'White', about: 'ANSI 7' },
      { token: 'term-bright-black', label: 'Bright black', about: 'ANSI 8 · agent reasoning' },
      { token: 'term-bright-red', label: 'Bright red', about: 'ANSI 9' },
      { token: 'term-bright-green', label: 'Bright green', about: 'ANSI 10' },
      { token: 'term-bright-yellow', label: 'Bright yellow', about: 'ANSI 11' },
      { token: 'term-bright-blue', label: 'Bright blue', about: 'ANSI 12' },
      { token: 'term-bright-magenta', label: 'Bright magenta', about: 'ANSI 13' },
      { token: 'term-bright-cyan', label: 'Bright cyan', about: 'ANSI 14' },
      { token: 'term-bright-white', label: 'Bright white', about: 'ANSI 15' }
    ]
  }
]

/** Every token the groups account for; a test holds it against `THEME_TOKENS` so none is unreachable. */
export const GROUPED_TOKENS: readonly ThemeToken[] = TOKEN_GROUPS.flatMap((group) =>
  group.tokens.map((entry) => entry.token)
)

/** True when the editor accounts for the whole palette, in the palette's order. */
export function groupsCoverEveryToken(): boolean {
  return GROUPED_TOKENS.length === THEME_TOKENS.length && THEME_TOKENS.every((token) => GROUPED_TOKENS.includes(token))
}
