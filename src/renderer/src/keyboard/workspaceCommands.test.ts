// The one dispatcher, and the one predicate in front of it.
//
// There are two ways into every command now — a chord and a menu item — and the
// only thing keeping them from disagreeing is that they are the same two
// functions. So these tests are written against those functions rather than
// against either caller: what `isCommandAvailable` says is what the menu greys
// and what the key handler declines, and what `runWorkspaceCommand` does is
// what happens either way.

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
  focusedWatchId: null
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
    openPaneSearch: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleDashboard: vi.fn(),
    toggleHelp: vi.fn(),
    openDialog: vi.fn(),
    closeDialog: vi.fn()
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
  // A question about a teammate's keystrokes is the one modal here that refuses
  // to be dismissed, and it was raised by another machine rather than by
  // anybody in this window. Nothing may act underneath it — which used to mean
  // only that no chord fired, and now has to mean that no menu item is live
  // either, because the menu bar is reachable with a modal on screen.
  it('offers nothing at all while a teammate’s question is waiting', () => {
    const asking = { ...WORKING, consent: QUESTION }
    for (const command of EVERY_COMMAND) expect(isCommandAvailable(command, asking), command).toBe(false)
  })

  // A dialog of this window's own owns the keyboard too, with the palette's one
  // exception: its own command is what closes it again.
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
    // Their machine owns the tree a split would go in, and a watched pane's
    // scrollback is a picture rather than a buffer that can be searched.
    expect(isCommandAvailable('split-right', watching)).toBe(false)
    expect(isCommandAvailable('split-down', watching)).toBe(false)
    expect(isCommandAvailable('find-in-pane', watching)).toBe(false)
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
      ['focus-next-pane', 'focusNextPane', []],
      ['open-palette', 'openDialog', [{ kind: 'palette' }]],
      ['find-in-pane', 'openPaneSearch', []],
      ['open-dashboard', 'toggleDashboard', []],
      ['open-appearance', 'openDialog', [{ kind: 'appearance' }]],
      ['open-help', 'toggleHelp', []]
    ]

    for (const [command, method, args] of cases) {
      // The walk needs somewhere to walk to; everything else is happy with one pane.
      const store = workspace(command === 'focus-next-pane' ? TWO_PANES : WORKING)
      runWorkspaceCommand(command, store)
      expect(store[method], command).toHaveBeenCalledExactlyOnceWith(...args)
      // And nothing else moved, so a command cannot quietly do two things.
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

  // The case a menu bar creates and a chord never could. A menu is built from a
  // snapshot and chosen some time afterwards: the item was live when it was
  // drawn, the pane it would have closed exited in between, and the click
  // arrives against a window where the command means nothing. The check is
  // therefore made again here rather than trusted to whoever is calling.
  it('does nothing when the window has moved on since the menu was built', () => {
    for (const command of EVERY_COMMAND) {
      const store = workspace(EMPTY)
      runWorkspaceCommand(command, store)
      if (['toggle-sidebar', 'open-palette', 'open-dashboard', 'open-appearance', 'open-help'].includes(command)) {
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
