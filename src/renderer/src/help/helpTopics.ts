// What the help page says, kept apart from the component that draws it.
//
// The same reason the dialog models are kept apart: the interesting part of a
// help page is its wording, and wording is worth testing. It is also the part
// most likely to quietly stop being true — every sentence below is a claim
// about what this app does, and the app goes on changing underneath it.
//
// Two of the three sections defend themselves differently.
//
// The keyboard section is not written here at all. It is derived from
// `WORKSPACE_SHORTCUTS`, which is the table the key handler itself reads, so
// the page cannot list a chord that does not fire or miss one that does. A
// hand-written table would be correct on the day it was typed and wrong on the
// day somebody rebinds a key — and it would be wrong silently, which is the
// only kind of wrong a help page is really capable of.
//
// The worktree section cannot be derived from anything, so it is held to the
// next best rule: every sentence in it is a statement the code makes somewhere,
// and the file that makes it is named in a comment above the prose. Nothing is
// in it because it sounds like how worktrees ought to work.

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

/**
 * Which group each binding is read under.
 *
 * A total record rather than a lookup with a default, and that is the whole
 * point of it: adding a command to `WORKSPACE_SHORTCUTS` without deciding where
 * a reader would look for it stops the build here, at the one file that has to
 * have an opinion about it. A default would have swallowed the new command into
 * whichever group was least wrong and said nothing.
 */
const GROUP_OF: Record<WorkspaceCommand, ShortcutGroupId> = {
  'split-right': 'panes',
  'split-down': 'panes',
  'close-pane': 'panes',
  'new-terminal': 'panes',
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
 * Every binding, in groups, with nothing added and nothing dropped.
 *
 * Built by walking the table once and putting each entry in exactly one bucket,
 * rather than by filtering the table once per group. The difference matters:
 * filtering is how a group comes to be defined by a predicate that has stopped
 * matching anything, and how a command ends up in none of them with every test
 * still green. Here a command cannot be in two groups and cannot be in none —
 * the walk puts it somewhere, and `GROUP_OF` is what says where.
 *
 * Empty groups are dropped, so a group whose commands have all been rebound
 * away leaves a heading behind rather than an empty list.
 *
 * Commands with no chord are left out: this is the keyboard section, and a row
 * in it with nothing in the key column is a reader being told about a key that
 * does not exist. They are in the menu bar and in the palette, which is where
 * the page's own text sends somebody looking for a command rather than a key.
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
 * The question underneath every other thing in this window, answered once.
 *
 * Each paragraph is a claim the code makes, and the code that makes it:
 *
 * 1. `git worktree add -b <branch> <path> <sha>` in `src/main/git/gitService.ts`
 *    — a second working directory with its own branch, from one repository.
 * 2. The README's first sentence about why this app exists, and the note at the
 *    top of `src/main/git/worktreeNaming.ts`: several agents at once is the
 *    product, and two of them in one checkout overwrite each other.
 * 3. `slugifyBranchName` in `src/shared/branchName.ts` makes the name,
 *    `allocateBranchName` disambiguates it, `resolveStartPoint` resolves where
 *    it starts, and `#buildCheckout` writes back the sha rather than the name.
 * 4. `session-manager.ts` starts a pane in the worktree's own directory, and
 *    `registerHandlers.ts` closes a worktree's panes when it is removed —
 *    `#detachCheckout` is what refuses to remove a checkout with work in it.
 *
 * Nothing that is not one of those is in here. A help page that describes a
 * behaviour the app does not have is worse than no help page, because it is
 * believed.
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

/**
 * The repository's own documents, linked rather than restated.
 *
 * Both files exist in this repository on `main`. They are opened in the user's
 * browser rather than in this window — see `setWindowOpenHandler` in
 * `src/main/index.ts` — which is why they are addresses and not a copy of the
 * prose: a copy is a second version of a document nobody would remember to
 * update.
 */
export const README_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/README.md'
export const TEAMWORK_DOCUMENT = 'https://github.com/zero-abd/teamree/blob/main/docs/teamwork.md'

/** What to type to be told what the installed build can do. */
export const CLI_HELP_COMMAND = 'teamree help'

export type CliHelp = {
  /** Where the command is now, in the words the install panel uses. */
  headline: string
  /**
   * What typing `teamree help` gets you, or null when it would not run.
   *
   * Null is the important half. Telling somebody to type a command that their
   * shell cannot find is the one thing this section must not do: they get
   * `command not found`, and the sentence that sent them there has just taught
   * them that the help page does not know what it is talking about.
   */
  command: string | null
  /** Why the settings page is worth opening, or null when it is not. */
  settings: string | null
  /** Said when the link exists and the shell may still not find it. */
  caveat: string | null
}

/**
 * What this section says, given what the runtime found on this machine.
 *
 * The headline is taken from `cliPanel` rather than written again, for the
 * reason `CLI_PURPOSE` is a constant: the install panel and this page describe
 * one state of one machine, and two wordings of that are two claims a reader
 * has to reconcile. Only the next step is this file's own, because the next
 * step from here is different — the panel has the button, and this has a
 * sentence pointing at where the button lives.
 */
export function cliHelp(status: CliStatus | null): CliHelp {
  const panel = cliPanel(status)

  // Still reading. No command and no errand, because both would be a guess:
  // the first answer has not come back, so nothing here knows yet whether the
  // command exists.
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
      // Non-null only when nothing teamree can read puts the link's directory
      // on a PATH, which is the one case where the sentence above is a
      // reasonable thing to say and still might not work.
      caveat: panel.pathWarning
    }
  }

  return {
    headline: panel.headline,
    command: null,
    // Deliberately says nothing about *why* — the headline above has already
    // said which of the six ways this is, and they are not the same errand. All
    // this has to carry is that the command will not describe this app until
    // something is done, and where the doing is.
    settings: `So ${CLI_HELP_COMMAND} will not describe this build until that is settled.`,
    caveat: null
  }
}

/** The label on the button that leaves for the settings page. */
export const CLI_SETTINGS_BUTTON = 'Open settings'
