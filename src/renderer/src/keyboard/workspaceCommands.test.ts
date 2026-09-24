// The one dispatcher and its predicate, tested directly: `isCommandAvailable` is what the menu greys and
// the key handler declines, and `runWorkspaceCommand` is what happens either way.

import { describe, expect, it, vi } from 'vitest'
import type { PaneNode, ConsentRequest } from '@shared/entities'
import type { CommandActions, CommandState, Workspace } from './workspaceCommands'
import { isCommandAvailable, paneNumberTarget, runWorkspaceCommand, whyUnavailable } from './workspaceCommands'
import { WORKSPACE_SHORTCUTS, type WorkspaceCommand } from './workspaceShortcuts'
import { onRegionRequest, type Region } from '../shell/regions'

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
  worktrees: [{ id: 'w1', projectId: 'p1', state: 'ready' }],
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
    saveFiles: vi.fn(async () => true),
    createTerminal: vi.fn(async () => {}),
    newMarkdown: vi.fn(),
    closeWatchedPane: vi.fn(),
    focusNextPane: vi.fn(),
    focusPreviousPane: vi.fn(),
    showPane: vi.fn(),
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
    showAppearance: vi.fn(),
    chooseProjectFolder: vi.fn(),
    showRightPanelTab: vi.fn(),
    pushActiveWorktree: vi.fn(async () => {}),
    setTerminalFontSize: vi.fn()
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

  // A dialog of this window's own too, except the palette, whose two chords switch or close it.
  it('offers nothing but the palette chords while a dialog is up', () => {
    const adding = { ...WORKING, dialog: { kind: 'clone-project' } as const }
    for (const command of EVERY_COMMAND) expect(isCommandAvailable(command, adding), command).toBe(false)

    const palette = { ...WORKING, dialog: { kind: 'palette' } as const }
    for (const command of EVERY_COMMAND) {
      expect(isCommandAvailable(command, palette), command).toBe(command === 'open-palette' || command === 'go-to-file')
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

  it('offers a new markdown pane on the same terms as a terminal', () => {
    expect(isCommandAvailable('new-markdown', EMPTY)).toBe(false)
    expect(isCommandAvailable('new-markdown', WORKING)).toBe(true)
    const gone = { ...WORKING, worktrees: [{ id: 'w1', projectId: 'p1', missing: true as const }] }
    expect(isCommandAvailable('new-markdown', gone)).toBe(false)
  })

  // On macOS a lit menu item takes its chord before the page sees it.
  it('lends the sidebar and board chords to a markdown editor while it is being typed in', () => {
    const editing = { ...WORKING, editingMarkdown: true }
    expect(isCommandAvailable('toggle-sidebar', editing)).toBe(false)
    expect(isCommandAvailable('open-dashboard', editing)).toBe(false)
    expect(isCommandAvailable('open-palette', editing)).toBe(true)
    expect(isCommandAvailable('close-pane', editing)).toBe(true)
    expect(isCommandAvailable('toggle-sidebar', WORKING)).toBe(true)
  })

  // Its text has the editor's own find, which takes the chord while the item is greyed.
  it('offers find on a file pane only while it shows its diff', () => {
    const layouts = {
      w1: { worktreeId: 'w1', root: { kind: 'leaf' as const, terminalId: 'file:1' }, focusedTerminalId: 'file:1' }
    }
    expect(isCommandAvailable('find-in-pane', { ...WORKING, layouts })).toBe(false)
    expect(isCommandAvailable('find-in-pane', { ...WORKING, layouts, diffPanes: { 'file:1': true } })).toBe(true)
    expect(isCommandAvailable('split-right', { ...WORKING, layouts })).toBe(true)
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

describe('why a command is unavailable', () => {
  it('names the reason in a few words, and nothing when it would run', () => {
    expect(whyUnavailable('save-file', WORKING)).toBe('nothing unsaved')
    expect(whyUnavailable('split-right', EMPTY)).toBe('no pane focused')
    expect(whyUnavailable('push-worktree', { ...WORKING, pushing: true })).toBe('pushing')
    expect(whyUnavailable('split-right', WORKING)).toBeNull()
  })

  it('agrees with the predicate for every command', () => {
    for (const { command } of WORKSPACE_SHORTCUTS) {
      for (const state of [EMPTY, WORKING]) {
        expect(whyUnavailable(command, state) === null).toBe(isCommandAvailable(command, state))
      }
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

describe('the focus items', () => {
  const asked = (command: WorkspaceCommand, state: CommandState): { regions: Region[]; store: Workspace } => {
    const regions: Region[] = []
    const stop = onRegionRequest((region) => regions.push(region))
    const store = workspace(state)
    runWorkspaceCommand(command, store)
    stop()
    return { regions, store }
  }

  it('asks for the region each names', () => {
    expect(asked('focus-sidebar', WORKING).regions).toEqual(['sidebar'])
    expect(asked('focus-panes', WORKING).regions).toEqual(['panes'])
    expect(asked('focus-right-panel', WORKING).regions).toEqual(['panel'])
  })

  // Shown first; the focus follows once it is drawn.
  it('shows a sidebar or panel that is put away', () => {
    const sidebar = asked('focus-sidebar', { ...WORKING, sidebarVisible: false })
    expect(sidebar.store.toggleSidebar).toHaveBeenCalledOnce()
    expect(sidebar.regions).toEqual(['sidebar'])
    const panel = asked('focus-right-panel', { ...WORKING, rightPanelOpen: false })
    expect(panel.store.toggleRightPanel).toHaveBeenCalledOnce()
    expect(
      asked('focus-right-panel', { ...WORKING, rightPanelOpen: true }).store.toggleRightPanel
    ).not.toHaveBeenCalled()
  })

  it('offers the panel only with a worktree open, and the rest always', () => {
    expect(isCommandAvailable('focus-right-panel', EMPTY)).toBe(false)
    for (const command of ['focus-sidebar', 'focus-panes', 'focus-next-region', 'focus-previous-region'] as const) {
      expect(isCommandAvailable(command, EMPTY), command).toBe(true)
    }
  })
})

describe('running a command', () => {
  it('does what each of them says', () => {
    const cases: Array<[WorkspaceCommand, string, unknown[]]> = [
      ['split-right', 'splitFocusedPane', ['row']],
      ['split-down', 'splitFocusedPane', ['column']],
      ['close-pane', 'closeTerminal', ['t1']],
      ['new-terminal', 'createTerminal', ['w1']],
      ['new-markdown', 'newMarkdown', ['w1']],
      ['new-worktree', 'openDialog', [{ kind: 'new-task', projectId: 'p1' }]],
      ['toggle-sidebar', 'toggleSidebar', []],
      ['toggle-right-panel', 'toggleRightPanel', []],
      ['focus-next-pane', 'focusNextPane', []],
      ['focus-previous-pane', 'focusPreviousPane', []],
      // From t1 of two, both ways land on t2.
      ['select-next-pane', 'showPane', ['t2']],
      ['select-previous-pane', 'showPane', ['t2']],
      ['expand-pane', 'toggleExpandedPane', []],
      // One method with a direction argument, so the two chords undo each other.
      ['previous-worktree', 'stepWorktree', [-1]],
      ['next-worktree', 'stepWorktree', [1]],
      ['open-palette', 'openDialog', [{ kind: 'palette' }]],
      ['go-to-file', 'openDialog', [{ kind: 'palette', mode: 'files' }]],
      ['find-in-pane', 'openPaneSearch', []],
      ['open-dashboard', 'toggleDashboard', []],
      ['open-appearance', 'showAppearance', [true]],
      ['add-project', 'chooseProjectFolder', []],
      ['clone-repository', 'openDialog', [{ kind: 'clone-project' }]],
      ['open-settings', 'toggleSettings', []],
      ['open-help', 'toggleHelp', []]
    ]

    for (const [command, method, args] of cases) {
      // Only the walks need somewhere to go; the git pair has its own case below.
      const paneWalk = /^(focus|select)-(next|previous)-pane$/.test(command)
      const worktreeWalk = command === 'previous-worktree' || command === 'next-worktree'
      const store = workspace(paneWalk ? TWO_PANES : worktreeWalk ? TWO_WORKTREES : WORKING)
      runWorkspaceCommand(command, store)
      expect(store[method], command).toHaveBeenCalledExactlyOnceWith(...args)
      // Nothing else moved.
      expect(callCount(store), command).toBe(1)
    }
  })

  it('starts a new task in the open worktree’s project, else the one added last', () => {
    const two = { ...WORKING, projects: [{ id: 'p1' }, { id: 'p2' }] }
    const open = workspace(two)
    runWorkspaceCommand('new-worktree', open)
    expect(open.openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p1' })

    const none = workspace({ ...two, activeWorktreeId: null })
    runWorkspaceCommand('new-worktree', none)
    expect(none.openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'new-task', projectId: 'p2' })
  })

  it('stops the watch when the focused pane is a teammate’s', () => {
    const store = workspace({ ...WORKING, focusedWatchId: 'watch:p1:priya:t7' })
    runWorkspaceCommand('close-pane', store)
    expect(store.closeWatchedPane).toHaveBeenCalledExactlyOnceWith('watch:p1:priya:t7')
    expect(store.closeTerminal).not.toHaveBeenCalled()
  })

  it('switches the palette between its modes, and puts it away on the chord of the mode on screen', () => {
    const commands = workspace({ ...WORKING, dialog: { kind: 'palette' } })
    runWorkspaceCommand('go-to-file', commands)
    expect(commands.openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'palette', mode: 'files' })

    const files = workspace({ ...WORKING, dialog: { kind: 'palette', mode: 'files' } })
    runWorkspaceCommand('go-to-file', files)
    expect(files.closeDialog).toHaveBeenCalledOnce()
    runWorkspaceCommand('open-palette', files)
    expect(files.openDialog).toHaveBeenCalledExactlyOnceWith({ kind: 'palette' })
  })

  it('offers Go to File only in a worktree whose checkout is there', () => {
    expect(isCommandAvailable('go-to-file', WORKING)).toBe(true)
    expect(isCommandAvailable('go-to-file', EMPTY)).toBe(false)
    const creating = { ...WORKING, worktrees: [{ id: 'w1', projectId: 'p1', state: 'creating' }] }
    expect(isCommandAvailable('go-to-file', creating)).toBe(false)
    const missing = { ...WORKING, worktrees: [{ id: 'w1', projectId: 'p1', state: 'ready', missing: true as const }] }
    expect(isCommandAvailable('go-to-file', missing)).toBe(false)
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
        [
          'toggle-sidebar',
          'open-palette',
          'open-dashboard',
          'open-appearance',
          'open-settings',
          'open-help',
          'add-project',
          'clone-repository',
          'bigger-text',
          'smaller-text'
        ].includes(command)
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

/** A terminal, a markdown file and a terminal, focused on the first: the strip reads t1, NOTES.md, t3. */
const THREE_TABS: CommandState = {
  ...WORKING,
  layouts: {
    w1: {
      worktreeId: 'w1',
      root: {
        kind: 'split',
        direction: 'row',
        sizes: [0.4, 0.3, 0.3],
        children: [
          { kind: 'leaf', terminalId: 't1' },
          { kind: 'leaf', terminalId: 'file:n', pane: 'file', path: 'NOTES.md' },
          { kind: 'leaf', terminalId: 't3' }
        ]
      },
      focusedTerminalId: 't1'
    }
  }
}

const focusedOn = (state: CommandState, id: string): CommandState => ({
  ...state,
  layouts: { w1: { ...(state.layouts.w1 as NonNullable<CommandState['layouts']['w1']>), focusedTerminalId: id } }
})

describe('the tab strip by key', () => {
  const shown = (command: WorkspaceCommand, state: CommandState): unknown => {
    const showPane = vi.fn()
    runWorkspaceCommand(command, { ...workspace(state), showPane })
    return showPane.mock.calls[0]?.[0]
  }

  it('walks every kind of tab in strip order, wrapping at both ends', () => {
    expect(shown('select-next-pane', THREE_TABS)).toBe('file:n')
    expect(shown('select-next-pane', focusedOn(THREE_TABS, 'file:n'))).toBe('t3')
    expect(shown('select-next-pane', focusedOn(THREE_TABS, 't3'))).toBe('t1')
    expect(shown('select-previous-pane', THREE_TABS)).toBe('t3')
  })

  // The strip marks no tab while a teammate's pane has the focus.
  it('starts from an end when a teammate’s pane has the focus', () => {
    const watching = { ...THREE_TABS, focusedWatchId: 'watch:p1:priya:t7' }
    expect(shown('select-next-pane', watching)).toBe('t1')
    expect(shown('select-previous-pane', watching)).toBe('t3')
  })

  it('needs two tabs to walk', () => {
    expect(isCommandAvailable('select-next-pane', WORKING)).toBe(false)
    expect(isCommandAvailable('select-previous-pane', THREE_TABS)).toBe(true)
  })

  it('names the Nth tab for 1 to 8 and the last for 9', () => {
    expect(paneNumberTarget(1, THREE_TABS)).toBe('t1')
    expect(paneNumberTarget(2, THREE_TABS)).toBe('file:n')
    expect(paneNumberTarget(3, THREE_TABS)).toBe('t3')
    expect(paneNumberTarget(4, THREE_TABS)).toBeNull()
    expect(paneNumberTarget(9, THREE_TABS)).toBe('t3')
    expect(paneNumberTarget(9, WORKING)).toBe('t1')
    expect(paneNumberTarget(1, EMPTY)).toBeNull()
  })

  it('names none under a dialog or a teammate’s question', () => {
    expect(paneNumberTarget(1, { ...THREE_TABS, dialog: { kind: 'palette' } })).toBeNull()
    expect(paneNumberTarget(1, { ...THREE_TABS, consent: QUESTION })).toBeNull()
  })
})

describe('the file column by key', () => {
  const file = (id: string): PaneNode => ({ kind: 'leaf', terminalId: id, pane: 'file', path: `${id}.ts` })
  const COLUMN: CommandState = {
    ...THREE_TABS,
    layouts: {
      w1: {
        worktreeId: 'w1',
        root: {
          kind: 'split',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [
            { kind: 'leaf', terminalId: 't1' },
            {
              kind: 'split',
              direction: 'column',
              sizes: [1 / 3, 1 / 3, 1 / 3],
              children: [file('f1'), file('f2'), file('f3')],
              tabs: true,
              shown: 'f2'
            }
          ]
        },
        focusedTerminalId: 't1'
      }
    }
  }
  const shown = (command: WorkspaceCommand, state: CommandState): unknown => {
    const showPane = vi.fn()
    runWorkspaceCommand(command, { ...workspace(state), showPane })
    return showPane.mock.calls[0]?.[0]
  }

  it('is one stop for ⌃Tab and the numbers, landing on its shown file', () => {
    expect(shown('select-next-pane', COLUMN)).toBe('f2')
    expect(shown('select-next-pane', focusedOn(COLUMN, 'f2'))).toBe('t1')
    expect(paneNumberTarget(2, COLUMN)).toBe('f2')
    expect(paneNumberTarget(3, COLUMN)).toBeNull()
  })

  it('steps through its own tabs, wrapping, only while one of them has the focus', () => {
    expect(isCommandAvailable('next-file-tab', COLUMN)).toBe(false)
    expect(isCommandAvailable('next-file-tab', focusedOn(COLUMN, 'f2'))).toBe(true)
    expect(shown('next-file-tab', focusedOn(COLUMN, 'f2'))).toBe('f3')
    expect(shown('next-file-tab', focusedOn(COLUMN, 'f3'))).toBe('f1')
    expect(shown('previous-file-tab', focusedOn(COLUMN, 'f2'))).toBe('f1')
  })
})

describe('the text size', () => {
  it('steps the terminal text by a pixel and resets it to 12', () => {
    const cases: Array<[WorkspaceCommand, number, number]> = [
      ['bigger-text', 12, 13],
      ['smaller-text', 12, 11],
      ['actual-size', 18, 12]
    ]
    for (const [command, from, to] of cases) {
      const store = workspace({ ...EMPTY, terminalFontSize: from })
      runWorkspaceCommand(command, store)
      expect(store.setTerminalFontSize, command).toHaveBeenCalledExactlyOnceWith(to)
    }
  })

  it('greys each item at the size where it would do nothing', () => {
    expect(isCommandAvailable('bigger-text', { ...EMPTY, terminalFontSize: 24 })).toBe(false)
    expect(isCommandAvailable('bigger-text', { ...EMPTY, terminalFontSize: 23 })).toBe(true)
    expect(isCommandAvailable('smaller-text', { ...EMPTY, terminalFontSize: 9 })).toBe(false)
    expect(isCommandAvailable('smaller-text', { ...EMPTY, terminalFontSize: 10 })).toBe(true)
    expect(isCommandAvailable('actual-size', { ...EMPTY, terminalFontSize: 12 })).toBe(false)
    expect(isCommandAvailable('actual-size', { ...EMPTY, terminalFontSize: 13 })).toBe(true)
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

describe('saving', () => {
  const EDITED: CommandState = {
    ...WORKING,
    layouts: {
      w1: {
        worktreeId: 'w1',
        root: { kind: 'leaf', terminalId: 'file:a', pane: 'file', path: 'a.ts' },
        focusedTerminalId: 'file:a'
      }
    },
    editedFiles: { 'file:a': { worktreeId: 'w1', path: 'a.ts' }, 'file:b': { worktreeId: 'w2', path: 'b.ts' } }
  }

  it('offers Save only on a focused pane with edits, and Save All while anything has them', () => {
    expect(isCommandAvailable('save-file', WORKING)).toBe(false)
    expect(isCommandAvailable('save-all', WORKING)).toBe(false)
    expect(isCommandAvailable('save-file', EDITED)).toBe(true)
    expect(isCommandAvailable('save-all', EDITED)).toBe(true)
    expect(isCommandAvailable('save-file', { ...EDITED, editedFiles: { 'file:b': { worktreeId: 'w2' } } })).toBe(false)
  })

  it('saves the focused pane, or every edited one', () => {
    const one = workspace(EDITED)
    runWorkspaceCommand('save-file', one)
    expect(one.saveFiles).toHaveBeenCalledExactlyOnceWith(['file:a'])
    const all = workspace(EDITED)
    runWorkspaceCommand('save-all', all)
    expect(all.saveFiles).toHaveBeenCalledExactlyOnceWith(['file:a', 'file:b'])
  })
})
