// The one dispatcher and its predicate, tested directly: `isCommandAvailable` is what the menu greys and
// the key handler declines, and `runWorkspaceCommand` is what happens either way.

import { describe, expect, it, vi } from 'vitest'
import type { ConsentRequest } from '@shared/entities'
import type { CommandActions, CommandState, Workspace } from './workspaceCommands'
import { isCommandAvailable, runWorkspaceCommand } from './workspaceCommands'
import { WORKSPACE_SHORTCUTS, type WorkspaceCommand } from './workspaceShortcuts'

const EMPTY: CommandState = {
  consent: {},
  dialog: null,
  projects: [],
  worktrees: [],
  activeWorktreeId: null,
  layouts: {},
  watches: [],
  focusedWatchId: null,
  statuses: {},
  pushing: false
}

const WORKING: CommandState = {
  ...EMPTY,
  projects: [{ id: 'p1' }],
  worktrees: [{ id: 'w1', projectId: 'p1' }],
  activeWorktreeId: 'w1',
  layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
}

/** The same window with the pane split in two, so there is somewhere to walk. */
const TWO_PANES: CommandState = {
  ...WORKING,
  layouts: {
    w1: {
      worktreeId: 'w1',
      root: {
        kind: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', terminalId: 't1' },
          { kind: 'leaf', terminalId: 't2' }
        ]
      },
      focusedTerminalId: 't1'
    }
  }
}

/** Two worktrees under one project, so there is a list to walk. */
const TWO_WORKTREES: CommandState = {
  ...WORKING,
  worktrees: [
    { id: 'w1', projectId: 'p1' },
    { id: 'w2', projectId: 'p1' }
  ]
}

/** One waiting question, as `teamwork.requests` hands it over. */
const QUESTION: Record<string, { requests: ConsentRequest[] }> = {
  p1: {
    requests: [
      {
        id: 'ask_1',
        projectId: 'p1',
        terminalId: 't1',
        handle: 'priya',
        publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
        since: 1_000,
        at: 1_500,
        expiresAt: 2_000,
        writes: 4,
        bytes: 4,
        preview: 'npm test',
        clipped: false
      }
    ]
  }
}

const EVERY_COMMAND: readonly WorkspaceCommand[] = WORKSPACE_SHORTCUTS.map((shortcut) => shortcut.command)

function actions(): CommandActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    splitFocusedPane: vi.fn(async () => {}),
    closeTerminal: vi.fn(async () => {}),
    createTerminal: vi.fn(async () => {}),
    closeWatchedPane: vi.fn(),
    focusNextPane: vi.fn(),
    focusPreviousPane: vi.fn(),
    toggleExpandedPane: vi.fn(),
    stepWorktree: vi.fn(),
    openPaneSearch: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleRightPanel: vi.fn(),
    toggleDashboard: vi.fn(),
    toggleHelp: vi.fn(),
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    toggleSettings: vi.fn(),
    showRightPanelTab: vi.fn(),
    pushActiveWorktree: vi.fn(async () => {})
  } as unknown as CommandActions & Record<string, ReturnType<typeof vi.fn>>
}

function workspace(state: CommandState): Workspace & Record<string, ReturnType<typeof vi.fn>> {
  return { ...state, ...actions() } as Workspace & Record<string, ReturnType<typeof vi.fn>>
}

/** How many of the store's methods were called, whichever they were. */
function callCount(store: Record<string, unknown>): number {
  return Object.values(store)
    .filter(
      (value): value is { mock: { calls: unknown[] } } => typeof value === 'function' && 'mock' in (value as object)
    )
    .reduce((total, fn) => total + fn.mock.calls.length, 0)
}

describe('what a window can be asked to do', () => {
  // A remote-keystrokes question refuses dismissal, so no chord and no menu item may act under it.
  it('offers nothing at all while a teammate’s question is waiting', () => {
    const asking = { ...WORKING, consent: QUESTION }
    for (const command of EVERY_COMMAND) expect(isCommandAvailable(command, asking), command).toBe(false)
  })

  // A dialog of this window's own too, except the palette, whose command closes it.
  it('offers nothing but closing the palette while a dialog is up', () => {
    const appearance = { ...WORKING, dialog: { kind: 'appearance' } as const }
    for (const command of EVERY_COMMAND) expect(isCommandAvailable(command, appearance), command).toBe(false)

    const palette = { ...WORKING, dialog: { kind: 'palette' } as const }
    for (const command of EVERY_COMMAND) {
      expect(isCommandAvailable(command, palette), command).toBe(command === 'open-palette')
    }
  })

  it('refuses the pane commands when the focused pane is a teammate’s', () => {
    const watching = { ...WORKING, focusedWatchId: 'watch:p1:priya:t7' }
    // Their machine owns the tree, and a watched scrollback is a picture, not a searchable buffer.
    expect(isCommandAvailable('split-right', watching)).toBe(false)
    expect(isCommandAvailable('split-down', watching)).toBe(false)
    expect(isCommandAvailable('find-in-pane', watching)).toBe(false)
    // Nor is there a tree for their pane to fill, or one to give back after.
    expect(isCommandAvailable('expand-pane', watching)).toBe(false)
    // Closing one, though, is the whole of stopping the watch.
    expect(isCommandAvailable('close-pane', watching)).toBe(true)
  })

  it('offers a new task only where there is a project to make one in', () => {
    expect(isCommandAvailable('new-worktree', EMPTY)).toBe(false)
    expect(isCommandAvailable('new-worktree', { ...EMPTY, projects: [{ id: 'p1' }] })).toBe(true)
  })

  it('offers a new terminal only with a worktree open to open it in', () => {
    expect(isCommandAvailable('new-terminal', EMPTY)).toBe(false)
    expect(isCommandAvailable('new-terminal', WORKING)).toBe(true)
  })

  // Open but the directory is gone: the shell would have nowhere to start.
  it('withholds a new terminal from a worktree whose checkout is not on disk', () => {
    const gone = { ...WORKING, worktrees: [{ id: 'w1', projectId: 'p1', missing: true as const }] }
    expect(isCommandAvailable('new-terminal', gone)).toBe(false)
  })

  it('offers the focus walk only where there is somewhere else to walk to', () => {
    expect(isCommandAvailable('focus-next-pane', EMPTY)).toBe(false)
    // One pane: the walk would land where the focus already is.
    expect(isCommandAvailable('focus-next-pane', WORKING)).toBe(false)
    expect(isCommandAvailable('focus-next-pane', TWO_PANES)).toBe(true)
    // A teammate's pane counts, so one of your own and one of theirs is a walk.
    expect(isCommandAvailable('focus-next-pane', { ...WORKING, watches: [{ id: 'watch:p1:priya:t7' }] })).toBe(true)
    // And one of theirs alone is not, for the same reason one of your own is not.
    expect(isCommandAvailable('focus-next-pane', { ...EMPTY, watches: [{ id: 'watch:p1:priya:t7' }] })).toBe(false)
  })

  // Backwards shares the rule, which is the claim being made.
  it('offers the walk backwards exactly where it offers it forwards', () => {
    for (const state of [EMPTY, WORKING, TWO_PANES, { ...WORKING, watches: [{ id: 'watch:p1:priya:t7' }] }]) {
      expect(isCommandAvailable('focus-previous-pane', state)).toBe(isCommandAvailable('focus-next-pane', state))
    }
  })

  it('offers maximising only with a pane of your own in front of you', () => {
    expect(isCommandAvailable('expand-pane', EMPTY)).toBe(false)
    // One pane is enough: maximising hides the strip and header.
    expect(isCommandAvailable('expand-pane', WORKING)).toBe(true)
  })

  it('offers the worktree moves only where there is a second worktree', () => {
    for (const command of ['previous-worktree', 'next-worktree'] as const) {
      expect(isCommandAvailable(command, EMPTY), command).toBe(false)
      // One worktree: the walk wraps straight back onto the one already open.
      expect(isCommandAvailable(command, WORKING), command).toBe(false)
      expect(isCommandAvailable(command, TWO_WORKTREES), command).toBe(true)
      // A worktree whose project is not in the sidebar has no row to walk to.
      expect(
        isCommandAvailable(command, {
          ...TWO_WORKTREES,
          worktrees: [
            { id: 'w1', projectId: 'p1' },
            { id: 'w2', projectId: 'gone' }
          ]
        }),
        command
      ).toBe(false)
    }
  })
})

describe('the right panel', () => {
  // No worktree open, nothing for the panel to show.
  it('can be toggled only with a worktree open', () => {
    expect(isCommandAvailable('toggle-right-panel', EMPTY)).toBe(false)
    expect(isCommandAvailable('toggle-right-panel', { ...WORKING, layouts: {} })).toBe(true)
    expect(isCommandAvailable('toggle-right-panel', WORKING)).toBe(true)
  })
})

describe('running a command', () => {
  it('does what each of them says', () => {
    const cases: Array<[WorkspaceCommand, string, unknown[]]> = [
      ['split-right', 'splitFocusedPane', ['row']],
      ['split-down', 'splitFocusedPane', ['column']],
      ['close-pane', 'closeTerminal', ['t1']],
      ['new-terminal', 'createTerminal', ['w1']],
      ['new-worktree', 'openDialog', [{ kind: 'new-task', projectId: 'p1' }]],
      ['toggle-sidebar', 'toggleSidebar', []],
      ['toggle-right-panel', 'toggleRightPanel', []],
      ['focus-next-pane', 'focusNextPane', []],
      ['focus-previous-pane', 'focusPreviousPane', []],
      ['expand-pane', 'toggleExpandedPane', []],
      // One method with a direction argument, so the two chords undo each other.
      ['previous-worktree', 'stepWorktree', [-1]],
      ['next-worktree', 'stepWorktree', [1]],
      ['open-palette', 'openDialog', [{ kind: 'palette' }]],
      ['find-in-pane', 'openPaneSearch', []],
      ['open-dashboard', 'toggleDashboard', []],
      ['open-appearance', 'openDialog', [{ kind: 'appearance' }]],
      ['open-settings', 'toggleSettings', []],
      ['open-help', 'toggleHelp', []]
    ]

    for (const [command, method, args] of cases) {
      // Only the walks need somewhere to go; the git pair has its own case below.
      const paneWalk = command === 'focus-next-pane' || command === 'focus-previous-pane'
      const worktreeWalk = command === 'previous-worktree' || command === 'next-worktree'
      const store = workspace(paneWalk ? TWO_PANES : worktreeWalk ? TWO_WORKTREES : WORKING)
      runWorkspaceCommand(command, store)
      expect(store[method], command).toHaveBeenCalledExactlyOnceWith(...args)
      // Nothing else moved.
      expect(callCount(store), command).toBe(1)
    }
  })

  it('stops the watch when the focused pane is a teammate’s', () => {
    const store = workspace({ ...WORKING, focusedWatchId: 'watch:p1:priya:t7' })
    runWorkspaceCommand('close-pane', store)
    expect(store.closeWatchedPane).toHaveBeenCalledExactlyOnceWith('watch:p1:priya:t7')
    expect(store.closeTerminal).not.toHaveBeenCalled()
  })

  it('puts the palette away when its own command is run with it open', () => {
    const store = workspace({ ...WORKING, dialog: { kind: 'palette' } })
    runWorkspaceCommand('open-palette', store)
    expect(store.closeDialog).toHaveBeenCalledTimes(1)
    expect(store.openDialog).not.toHaveBeenCalled()
  })

  // A menu item is chosen after its snapshot; the pane may have exited, so the check runs again.
  it('does nothing when the window has moved on since the menu was built', () => {
    for (const command of EVERY_COMMAND) {
      const store = workspace(EMPTY)
      runWorkspaceCommand(command, store)
      if (
        ['toggle-sidebar', 'open-palette', 'open-dashboard', 'open-appearance', 'open-settings', 'open-help'].includes(
          command
        )
      ) {
        continue
      }
      expect(callCount(store), command).toBe(0)
    }
  })

  it('does nothing at all while a teammate’s question is waiting', () => {
    for (const command of EVERY_COMMAND) {
      const store = workspace({ ...WORKING, consent: QUESTION })
      runWorkspaceCommand(command, store)
      expect(callCount(store), command).toBe(0)
    }
  })
})

// Settings (⌘,), and the git pair, offered only with something to do.
describe('the commands that were in no menu', () => {
  const AHEAD: CommandState = { ...WORKING, statuses: { w1: { ahead: 1 } } } as CommandState
  const DIRTY: CommandState = { ...WORKING, statuses: { w1: { unstaged: 2 } } } as CommandState

  it('offers the settings page whatever the window holds', () => {
    expect(isCommandAvailable('open-settings' as WorkspaceCommand, EMPTY)).toBe(true)
  })

  it('offers Push only with a commit the remote has not, and not while one is in flight', () => {
    expect(isCommandAvailable('push-worktree' as WorkspaceCommand, WORKING)).toBe(false)
    expect(isCommandAvailable('push-worktree' as WorkspaceCommand, AHEAD)).toBe(true)
    expect(isCommandAvailable('push-worktree' as WorkspaceCommand, { ...AHEAD, pushing: true } as CommandState)).toBe(
      false
    )
  })

  it('offers Commit… only where something has changed', () => {
    expect(isCommandAvailable('commit-changes' as WorkspaceCommand, WORKING)).toBe(false)
    expect(isCommandAvailable('commit-changes' as WorkspaceCommand, DIRTY)).toBe(true)
  })

  it('runs each of them through the one dispatcher', () => {
    const settings = workspace(WORKING)
    runWorkspaceCommand('open-settings' as WorkspaceCommand, settings)
    expect(settings.toggleSettings).toHaveBeenCalledTimes(1)

    const pushing = workspace(AHEAD)
    runWorkspaceCommand('push-worktree' as WorkspaceCommand, pushing)
    expect(pushing.pushActiveWorktree).toHaveBeenCalledTimes(1)

    // Commit shows the changes tab (the message box) rather than toggling it.
    const changes = workspace(DIRTY)
    runWorkspaceCommand('commit-changes' as WorkspaceCommand, changes)
    expect(changes.showRightPanelTab).toHaveBeenCalledExactlyOnceWith('changes')
    expect(changes.toggleRightPanel).not.toHaveBeenCalled()
  })
})
