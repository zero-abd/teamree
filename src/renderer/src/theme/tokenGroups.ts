// What each colour token is for, in an editor's words, grouped by what moves together; within a group,
// declaration order, ground first, so editing top to bottom goes back to front.

import { THEME_TOKENS, type ThemeToken } from '@shared/theme'

export type TokenGroup = {
  title: string
  /** Why somebody would open this group rather than another. */
  blurb: string
  tokens: readonly { token: ThemeToken; label: string; about: string }[]
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    title: 'Surfaces',
    blurb: 'The window, the chrome around it, and the things that float over both.',
    tokens: [
      { token: 'bg-window', label: 'Window', about: 'The ground everything sits on, and the terminal background.' },
      { token: 'bg-rail', label: 'Rail', about: 'The sidebar, the pane strip and the status bar.' },
      { token: 'bg-panel', label: 'Panel', about: 'Pane headers, tab strips and the changes list.' },
      { token: 'bg-raised', label: 'Raised', about: 'Dialogs, the palette, buttons and pop-ups.' },
      { token: 'bg-input', label: 'Field', about: 'The inside of a text field.' },
      { token: 'bg-hover', label: 'Hover', about: 'What a row is tinted with under the pointer.' },
      { token: 'bg-press', label: 'Press', about: 'The same row while it is being held.' },
      { token: 'scrim', label: 'Scrim', about: 'What dims the window behind an open dialog.' }
    ]
  },
  {
    title: 'Lines',
    blurb: 'Hairlines and separators.',
    tokens: [
      { token: 'line', label: 'Hairline', about: 'Borders between regions.' },
      { token: 'line-strong', label: 'Strong line', about: 'Button and field borders, and the key caps.' }
    ]
  },
  {
    title: 'Text',
    blurb: 'Three weights of ink.',
    tokens: [
      { token: 'fg', label: 'Text', about: 'Worktree names, dialog bodies, terminal output.' },
      { token: 'fg-secondary', label: 'Secondary', about: 'Field labels, notice text, the rail.' },
      { token: 'fg-muted', label: 'Muted', about: 'Branches, counts, timestamps, hints.' }
    ]
  },
  {
    title: 'Accent',
    blurb: 'Where you are, and what is selected.',
    tokens: [
      { token: 'accent', label: 'Accent', about: 'The active marker, the primary button, the wordmark dot.' },
      { token: 'accent-bright', label: 'Accent text', about: 'The accent when it has to be read rather than seen.' },
      { token: 'accent-soft', label: 'Accent wash', about: 'The tint behind a selected row.' },
      { token: 'accent-line', label: 'Accent line', about: 'The border of a focused field, and the focus ring.' },
      { token: 'on-accent', label: 'On accent', about: 'The label on a filled accent button.' }
    ]
  },
  {
    title: 'Status',
    blurb: 'Four meanings; the terminal draws its red, green, yellow and blue from these.',
    tokens: [
      { token: 'success', label: 'Success', about: 'A clean merge, a pane that finished.' },
      { token: 'warning', label: 'Warning', about: 'What a discard is about to cost.' },
      { token: 'danger', label: 'Danger', about: 'Conflicts, failures, the destructive button.' },
      { token: 'info', label: 'Info', about: 'A notice that is not an error.' }
    ]
  },
  {
    title: 'Terminal',
    blurb: 'The sixteen ANSI colours, as the panes draw them.',
    tokens: [
      { token: 'term-bg', label: 'Background', about: 'Behind a pane. Usually the window ground itself.' },
      { token: 'term-fg', label: 'Foreground', about: 'Plain output with no colour of its own.' },
      { token: 'term-cursor', label: 'Cursor', about: 'The bar in the focused pane.' },
      { token: 'term-selection', label: 'Selection', about: 'Selected text, and every search match.' },
      { token: 'term-black', label: 'Black', about: 'ANSI 0.' },
      { token: 'term-red', label: 'Red', about: 'A failing test.' },
      { token: 'term-green', label: 'Green', about: 'A passing one.' },
      { token: 'term-yellow', label: 'Yellow', about: 'A warning in a build log.' },
      { token: 'term-blue', label: 'Blue', about: 'Paths and links.' },
      { token: 'term-magenta', label: 'Magenta', about: 'Prompts and diff headers.' },
      { token: 'term-cyan', label: 'Cyan', about: 'The other half of a diff header.' },
      { token: 'term-white', label: 'White', about: 'Output that asked for plain white.' },
      { token: 'term-bright-black', label: 'Bright black', about: 'What most agents print their reasoning in.' },
      { token: 'term-bright-red', label: 'Bright red', about: 'ANSI 9.' },
      { token: 'term-bright-green', label: 'Bright green', about: 'ANSI 10.' },
      { token: 'term-bright-yellow', label: 'Bright yellow', about: 'ANSI 11.' },
      { token: 'term-bright-blue', label: 'Bright blue', about: 'ANSI 12.' },
      { token: 'term-bright-magenta', label: 'Bright magenta', about: 'ANSI 13.' },
      { token: 'term-bright-cyan', label: 'Bright cyan', about: 'ANSI 14.' },
      { token: 'term-bright-white', label: 'Bright white', about: 'ANSI 15.' }
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
