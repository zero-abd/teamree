// The help page's one structural promise: it cannot fall behind the bindings.
//
// The keyboard section is grouped, and grouping is where a generated list goes
// back to being a hand-written one without anybody noticing. A command left out
// of the partition is gone from the page just as completely as if the page had
// never mentioned it — the difference is only that it looks derived. So the
// assertions below are written against `WORKSPACE_SHORTCUTS` itself and never
// against a list of command names typed out here: naming the commands would
// make this test exactly the second hand-written table it exists to prevent.

import { describe, expect, it } from 'vitest'
import type { CliStatus } from '@shared/entities'
import { WORKSPACE_SHORTCUTS, type WorkspaceShortcut } from '../keyboard/workspaceShortcuts'
import { CLI_HELP_COMMAND, cliHelp, shortcutGroups, WORKTREE_LINE } from './helpTopics'

/** Every shortcut the groups hold, flattened back out in group order. */
function grouped(): WorkspaceShortcut[] {
  return shortcutGroups().flatMap((group) => [...group.shortcuts])
}

/**
 * The bindings, which is what the keyboard section is a list of. Commands in
 * the table with no chord are reachable from the menu bar and the palette and
 * are not keys; derived here rather than named, for the reason at the top.
 */
const BOUND: readonly WorkspaceShortcut[] = WORKSPACE_SHORTCUTS.filter((shortcut) => shortcut.chord !== undefined)

describe('the shortcut groups', () => {
  // If the table were ever emptied this whole file would pass by describing
  // nothing, so the size it is checking is checked first.
  it('has a table to partition', () => {
    expect(BOUND.length).toBeGreaterThan(5)
  })

  it('holds every binding in the table, and each of them once', () => {
    const commands = grouped().map((shortcut) => shortcut.command)
    for (const shortcut of BOUND) {
      expect(commands.filter((command) => command === shortcut.command)).toEqual([shortcut.command])
    }
    expect(commands).toHaveLength(BOUND.length)
  })

  // A command with no key is not a row in a list of keys.
  it('leaves out a command the table binds to nothing', () => {
    const commands = grouped().map((shortcut) => shortcut.command)
    for (const shortcut of WORKSPACE_SHORTCUTS) {
      if (shortcut.chord === undefined) expect(commands, shortcut.command).not.toContain(shortcut.command)
    }
  })

  it('invents nothing the table does not have', () => {
    for (const shortcut of grouped()) {
      expect(WORKSPACE_SHORTCUTS).toContain(shortcut)
    }
  })

  // A heading over nothing is the shape a group takes on its way out, and it
  // reads to a user as a section that failed to load.
  it('shows no group with nothing under it', () => {
    for (const group of shortcutGroups()) expect(group.shortcuts.length).toBeGreaterThan(0)
  })

  // The partition is over whatever it is given, not over the module-level
  // table: a binding this file has never heard of still has to come out the
  // other side.
  it('partitions a table it is handed, not the one it imported', () => {
    const one = BOUND[0]
    expect(one).toBeDefined()
    const groups = shortcutGroups([one as WorkspaceShortcut])
    expect(groups.flatMap((group) => [...group.shortcuts])).toEqual([one])
  })
})

describe('what a worktree is', () => {
  it('answers the question in one line rather than gesturing at it', () => {
    expect(WORKTREE_LINE).toContain('second working directory')
    expect(WORKTREE_LINE).toContain('own branch')
    // The two facts this app is most likely to be blamed for: where a pane's shell is, and what a removal takes.
    expect(WORKTREE_LINE).toContain('panes start in it')
    expect(WORKTREE_LINE).toContain('closes them')
    expect(WORKTREE_LINE).not.toMatch(/\.(\s|$)/)
    expect(WORKTREE_LINE.length).toBeLessThanOrEqual(110)
  })
})

describe('the CLI section', () => {
  // The heading says what the command is; the section says where it is. It used
  // to open with a sentence selling the CLI to somebody already reading about it.
  it('says where the command is, without restating what the CLI is for', () => {
    const help = cliHelp(status({ state: 'linked' }))
    expect(help.headline).toBe('On your PATH')
  })

  it('sends you to the command once the command exists', () => {
    const help = cliHelp(status({ state: 'linked' }))
    expect(help.command).toBe(CLI_HELP_COMMAND)
    expect(help.settings).toBe(false)
  })

  // The one thing this section must not do. A command that is not on PATH is a
  // `command not found`, and a help page that produces one has taught its
  // reader that it does not know what it is talking about.
  it('never offers the command when a shell could not find it', () => {
    for (const state of ['absent', 'elsewhere', 'file', 'directory'] as const) {
      const help = cliHelp(status({ state }))
      expect(help.command, state).toBeNull()
      expect(help.settings, state).toBe(true)
    }
  })

  it('points nowhere at all until the first read has come back', () => {
    const help = cliHelp(null)
    expect(help.command).toBeNull()
    expect(help.settings).toBe(false)
  })

  // A link that was made and still will not be found is the one case where
  // "type teamree help" is both the right advice and possibly useless, so the
  // sentence that says so has to survive into this page.
  it('carries the warning that the directory is on no PATH it can read', () => {
    expect(cliHelp(status({ state: 'linked', onPath: null })).caveat).toBe('/usr/local/bin not on PATH')
    expect(cliHelp(status({ state: 'linked', onPath: 'login' })).caveat).toBeNull()
  })
})

/** A CLI status that is ordinary in every way except what a test names. */
function status(patch: Partial<CliStatus> = {}): CliStatus {
  return {
    installable: true,
    platform: 'darwin',
    source: '/Applications/teamree.app/Contents/Resources/cli/teamree',
    packaged: true,
    bundle: '/Applications/teamree.app/Contents/Resources/cli/index.js',
    impermanent: null,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'absent',
    resolved: null,
    dangling: false,
    needsAdministrator: true,
    onPath: 'login',
    askedAt: null,
    readAt: 0,
    ...patch
  }
}
