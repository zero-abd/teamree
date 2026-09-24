// What the help page says. The keyboard section is derived from `WORKSPACE_SHORTCUTS`, the table the
// key handler reads; the worktree section names the code behind each claim.

import type { CliStatus } from '@shared/entities'
import { cliPanel } from '../dialogs/cliInstallModel'
import { formatChord, type PlatformModifier } from '../keyboard/platformModifier'
import { WORKSPACE_SHORTCUTS, type WorkspaceCommand, type WorkspaceShortcut } from '../keyboard/workspaceShortcuts'

export const HELP_TITLE = 'Help'

/* The keyboard ------------------------------------------------------------ */

export type ShortcutGroupId = 'panes' | 'around' | 'app'

export type ShortcutGroup = {
  id: ShortcutGroupId
  title: string
  /** One line saying what the group is about, or null when the title says it. */
  blurb: string | null
  shortcuts: readonly WorkspaceShortcut[]
}

/** Which group each binding is read under; total, so a new command fails the build until placed. */
const GROUP_OF: Record<WorkspaceCommand, ShortcutGroupId> = {
  'split-right': 'panes',
  'split-down': 'panes',
  'close-pane': 'panes',
  'reopen-closed-pane': 'panes',
  'save-file': 'panes',
  'save-all': 'panes',
  'new-terminal': 'panes',
  'new-markdown': 'panes',
  'find-in-pane': 'panes',
  'focus-next-pane': 'panes',
  'focus-previous-pane': 'panes',
  'select-next-pane': 'panes',
  'select-previous-pane': 'panes',
  'next-file-tab': 'panes',
  'previous-file-tab': 'panes',
  'expand-pane': 'panes',
  'new-worktree': 'around',
  'previous-worktree': 'around',
  'next-worktree': 'around',
  'next-needing': 'around',
  'previous-needing': 'around',
  'open-palette': 'around',
  'go-to-file': 'around',
  'open-dashboard': 'around',
  'toggle-sidebar': 'around',
  'toggle-right-panel': 'around',
  'focus-sidebar': 'around',
  'focus-panes': 'around',
  'focus-right-panel': 'around',
  'focus-next-region': 'around',
  'focus-previous-region': 'around',
  'open-appearance': 'app',
  'open-settings': 'app',
  'add-project': 'app',
  'clone-repository': 'app',
  'open-help': 'app',
  'bigger-text': 'app',
  'smaller-text': 'app',
  'actual-size': 'app',
  'review-changes': 'around',
  'commit-changes': 'around',
  'push-worktree': 'around'
}

const GROUP_ORDER: ReadonlyArray<{ id: ShortcutGroupId; title: string; blurb: string | null }> = [
  { id: 'panes', title: 'Panes', blurb: null },
  { id: 'around', title: 'Getting around', blurb: null },
  { id: 'app', title: 'The window', blurb: null }
]

/**
 * Every binding in exactly one group (one walk, not a filter per group); empty groups dropped.
 * Commands with no chord are left out: they live in the menu bar and the palette.
 */
export function shortcutGroups(
  shortcuts: readonly WorkspaceShortcut[] = WORKSPACE_SHORTCUTS
): readonly ShortcutGroup[] {
  const buckets = new Map<ShortcutGroupId, WorkspaceShortcut[]>()
  for (const entry of GROUP_ORDER) buckets.set(entry.id, [])
  for (const shortcut of shortcuts) {
    if (shortcut.chord === undefined) continue
    buckets.get(GROUP_OF[shortcut.command])?.push(shortcut)
  }

  return GROUP_ORDER.map((entry) => ({ ...entry, shortcuts: buckets.get(entry.id) ?? [] })).filter(
    (group) => group.shortcuts.length > 0
  )
}

/** The ⌘1–⌘9 rows, read under Panes; the digits live outside the table (see `paneNumberForEvent`). */
export function paneNumberRows(modifier: PlatformModifier): readonly { title: string; chord: string }[] {
  const chord = (key: string): string => formatChord({ key }, modifier)
  return [
    { title: 'Pane 1–8', chord: `${chord('1')}–${chord('8')}` },
    { title: 'Last Pane', chord: chord('9') }
  ]
}

/* What a worktree is ------------------------------------------------------ */

export const WORKTREE_TITLE = 'What a worktree is'

/** What a worktree is, in one line of claims the code makes (`git worktree add` in gitService.ts, one per task). */
export const WORKTREE_LINE =
  'A second working directory on its own branch, one per task · panes start in it, removing it closes them'

/* The CLI ----------------------------------------------------------------- */

export const CLI_TITLE = 'The teamree command'

/** The repository's own documents, linked (opened in the browser) rather than restated. */
export const README_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/README.md'
export const TEAMWORK_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/docs/teamwork.md'

/** What to type to be told what the installed build can do. */
export const CLI_HELP_COMMAND = 'teamree help'

export type CliHelp = {
  /** Where the command is now, in the words the install panel uses. */
  headline: string
  /** The command that lists the rest, or null when the shell would not find it. */
  command: string | null
  /** Whether to offer the settings page, where the command is put on PATH. */
  settings: boolean
  /** Said when the link exists and the shell may still not find it. */
  caveat: string | null
}

/** What this section says for this machine; the headline is `cliPanel`'s, only the next step is ours. */
export function cliHelp(status: CliStatus | null): CliHelp {
  const panel = cliPanel(status)

  // Still reading: no command and no errand until the first answer is back.
  if (status === null) {
    return { headline: panel.headline, command: null, settings: false, caveat: null }
  }

  if (status.state === 'linked') {
    // The caveat is non-null only when no readable PATH includes the link's directory.
    return { headline: panel.headline, command: CLI_HELP_COMMAND, settings: false, caveat: panel.pathWarning }
  }

  // The headline already said which case this is.
  return { headline: panel.headline, command: null, settings: true, caveat: null }
}

/** The label on the button that leaves for the settings page. */
export const CLI_SETTINGS_BUTTON = 'Open Settings'
