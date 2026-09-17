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
import { CLI_PURPOSE, cliPanel } from '../dialogs/cliInstallModel'
import { WORKSPACE_SHORTCUTS, type WorkspaceCommand, type WorkspaceShortcut } from '../keyboard/workspaceShortcuts'

export const HELP_TITLE = 'Help'
export const HELP_LEDE = 'The keys this window answers to, what a worktree is, and where the rest is written down.'

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
  'new-worktree': 'around',
  'open-palette': 'around',
  'open-dashboard': 'around',
  'toggle-sidebar': 'around',
  'open-appearance': 'app',
  'open-help': 'app'
}

const GROUP_ORDER: ReadonlyArray<{ id: ShortcutGroupId; title: string; blurb: string | null }> = [
  { id: 'panes', title: 'Panes', blurb: 'The terminals in the worktree that is open.' },
  { id: 'around', title: 'Getting around', blurb: 'Starting work, and finding the pane you meant.' },
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
 */
export function shortcutGroups(
  shortcuts: readonly WorkspaceShortcut[] = WORKSPACE_SHORTCUTS
): readonly ShortcutGroup[] {
  const buckets = new Map<ShortcutGroupId, WorkspaceShortcut[]>()
  for (const entry of GROUP_ORDER) buckets.set(entry.id, [])
  for (const shortcut of shortcuts) buckets.get(GROUP_OF[shortcut.command])?.push(shortcut)

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
  'A worktree is a second working directory for a repository you already have, with its own branch checked out. ' +
    'It is not a clone: git keeps one repository and one history, and hands out as many working directories as you ' +
    'ask it for, each one on a different branch.',
  'teamree makes one per task, and that is the reason it exists. Several coding agents turned loose on a single ' +
    'checkout overwrite each other’s files and leave one branch holding all of it. In a worktree each has its own ' +
    'copy of every file and its own branch, so nothing one of them writes appears in another’s files.',
  'The branch is made from the task you describe. The description is reduced to lowercase words joined by dashes ' +
    '— the name shown under the box in the new-task dialog is the name you get — and a number is added if a ' +
    'branch by that name already exists. It starts from the start point that dialog offers, which is the ' +
    'repository’s own trunk unless you change it, and teamree records the commit that resolved to rather than the ' +
    'name, because a name can move afterwards and a commit cannot.',
  'Every pane you open in a worktree starts in that directory, so an agent running in one is looking at that ' +
    'branch’s files and no others. Removing a worktree takes its panes with it and stops what was running in them; ' +
    'a checkout with uncommitted work in it is refused rather than deleted, until you say to discard it.'
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
  /** What the CLI is for. One sentence, and the same one the dialog uses. */
  purpose: string
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
      purpose: CLI_PURPOSE,
      headline: panel.headline,
      command: null,
      settings: null,
      caveat: null
    }
  }

  if (status.state === 'linked') {
    return {
      purpose: CLI_PURPOSE,
      headline: panel.headline,
      command:
        `Type ${CLI_HELP_COMMAND} in any terminal for the commands this build has. That listing is generated from ` +
        'the CLI’s own command table, so it describes the teamree you have installed and cannot fall behind it.',
      settings: null,
      // Non-null only when nothing teamree can read puts the link's directory
      // on a PATH, which is the one case where the sentence above is a
      // reasonable thing to say and still might not work.
      caveat: panel.pathWarning
    }
  }

  return {
    purpose: CLI_PURPOSE,
    headline: panel.headline,
    command: null,
    // Deliberately says nothing about *why* — the headline above has already
    // said which of the six ways this is, and they are not the same errand. All
    // this has to carry is that the command will not describe this app until
    // something is done, and where the doing is.
    settings:
      `So ${CLI_HELP_COMMAND} will not tell you about this build until that is settled. Settings says where the ` +
      'command goes and what it takes to put it there.',
    caveat: null
  }
}

/** The label on the button that leaves for the settings page. */
export const CLI_SETTINGS_BUTTON = 'Open settings'
