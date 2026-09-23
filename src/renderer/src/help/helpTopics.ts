// What the help page says. The keyboard section is derived from `WORKSPACE_SHORTCUTS`, the table the
// key handler reads; the worktree section names the code behind each claim.

import type { CliStatus } from '@shared/entities'
import { cliPanel } from '../dialogs/cliInstallModel'
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
  'new-terminal': 'panes',
  'new-markdown': 'panes',
  'find-in-pane': 'panes',
  'focus-next-pane': 'panes',
  'focus-previous-pane': 'panes',
  'expand-pane': 'panes',
  'new-worktree': 'around',
  'previous-worktree': 'around',
  'next-worktree': 'around',
  'open-palette': 'around',
  'open-dashboard': 'around',
  'toggle-sidebar': 'around',
  'toggle-right-panel': 'around',
  'open-appearance': 'app',
  'open-settings': 'app',
  'open-help': 'app',
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

/* What a worktree is ------------------------------------------------------ */

export const WORKTREE_TITLE = 'What a worktree is'

/**
 * What a worktree is, each paragraph a claim the code makes: `git worktree add` in gitService.ts;
 * why several agents need several checkouts (worktreeNaming.ts); branchName.ts naming and
 * `resolveStartPoint`; panes start in the worktree and `#detachCheckout` refuses to lose work.
 */
export const WORKTREE_PARAGRAPHS: readonly string[] = [
  'A worktree is a second working directory on its own branch, from one repository and one history. teamree makes ' +
    'one per task so agents do not overwrite each other.',
  'The branch name is slugified from the task description, numbered if it is taken, and started from the start ' +
    'point the new-task dialog offers; teamree records the commit it resolved to, not the name.',
  'Panes in a worktree start in its directory. Removing one closes its panes; a checkout with uncommitted work is ' +
    'refused until you say to discard it.'
]

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
  /** What `teamree help` gets you, or null when the shell would not find it. */
  command: string | null
  /** Why the settings page is worth opening, or null when it is not. */
  settings: string | null
  /** Said when the link exists and the shell may still not find it. */
  caveat: string | null
}

/** What this section says for this machine; the headline is `cliPanel`'s, only the next step is ours. */
export function cliHelp(status: CliStatus | null): CliHelp {
  const panel = cliPanel(status)

  // Still reading: no command and no errand until the first answer is back.
  if (status === null) {
    return {
      headline: panel.headline,
      command: null,
      settings: null,
      caveat: null
    }
  }

  if (status.state === 'linked') {
    return {
      headline: panel.headline,
      command: `Type ${CLI_HELP_COMMAND} in any terminal for the commands this build has.`,
      settings: null,
      // Non-null only when no readable PATH includes the link's directory.
      caveat: panel.pathWarning
    }
  }

  return {
    headline: panel.headline,
    command: null,
    // Deliberately not why: the headline already said which case this is.
    settings: `So ${CLI_HELP_COMMAND} will not describe this build until that is settled.`,
    caveat: null
  }
}

/** The label on the button that leaves for the settings page. */
export const CLI_SETTINGS_BUTTON = 'Open settings'
