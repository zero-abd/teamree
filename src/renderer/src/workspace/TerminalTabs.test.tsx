/** @vitest-environment jsdom */

// The strip belongs to the open worktree only; its selected tab is the focused pane (none while a
// watched pane has focus); and its end buttons are the only pointer way to split or open a pane.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConversation, InstalledAgent, Layout, PaneNode, Terminal } from '@shared/entities'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import { leaf } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { GroupStrip, WorkspaceHead, cutTabsOutOfView } = await import('./TerminalTabs')
const { paneGroups, groupTabIds } = await import('../panes/paneGroups')
const { shownRoot } = await import('../panes/paneLayout')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

/** What `agent.list` answered at startup, as the store keeps it. */
const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }
const codex: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }

const terminal = (overrides: Partial<Terminal> & { id: string }): Terminal => ({
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/repos/pager-wt/rewrite',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

/** The records as the store holds them: by id, in whatever order they arrived. */
const byId = (...panes: Terminal[]): Record<string, Terminal> =>
  Object.fromEntries(panes.map((pane) => [pane.id, pane]))

const row = (...terminalIds: string[]): PaneNode => ({
  kind: 'split',
  direction: 'row',
  sizes: terminalIds.map(() => 1 / terminalIds.length),
  children: terminalIds.map((terminalId) => leaf(terminalId))
})

const layout = (worktreeId: string, root: PaneNode | null, focusedTerminalId: string | null): Layout => ({
  worktreeId,
  root,
  focusedTerminalId
})

const focusPane = vi.fn()
const closeTerminal = vi.fn(async () => {})
const createTerminal = vi.fn(async () => {})
const splitFocusedPane = vi.fn(async () => {})
const renamePane = vi.fn(async () => {})
const toggleSidebar = vi.fn()
const startAgent = vi.fn(async () => {})
const openSettings = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      focusPane,
      closeTerminal,
      createTerminal,
      splitFocusedPane,
      renamePane,
      toggleSidebar,
      startAgent,
      openSettings,
      ...overrides
    },
    true
  )
}

/** The top strip and, as the pane tree lays them along the top, one strip per group of the tree on screen. */
function Strips(): React.JSX.Element {
  const state = useWorkspaceStore()
  const layout = state.activeWorktreeId === null ? undefined : state.layouts[state.activeWorktreeId]
  const panesShown = !state.dashboardOpen && state.teamworkProjectId === null && !state.settingsOpen && !state.helpOpen
  const groups = panesShown ? paneGroups(shownRoot(layout?.root ?? null, state.expandedTerminalId)) : []
  const worktree = state.worktrees.find((entry) => entry.id === state.activeWorktreeId)
  const focused = state.focusedWatchId === null ? (layout?.focusedTerminalId ?? null) : null
  return (
    <>
      <WorkspaceHead modifier={MAC} />
      {groups.map((group) => (
        <GroupStrip
          key={groupTabIds(group)[0]}
          group={group}
          terminals={state.terminals}
          worktree={worktree}
          active={focused !== null && groupTabIds(group).includes(focused)}
          modifier={MAC}
          onFocus={state.focusPane}
          onClose={(id) => void state.closeTerminal(id)}
        />
      ))}
    </>
  )
}

const mount = (): void => {
  render(<Strips />)
}

/** The names on the strip, in the order it puts them. */
const tabNames = (): (string | null)[] => screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))

beforeEach(() => {
  focusPane.mockReset()
  closeTerminal.mockReset()
  createTerminal.mockReset()
  splitFocusedPane.mockReset()
  renamePane.mockReset()
  toggleSidebar.mockReset()
  startAgent.mockReset()
  openSettings.mockReset()
  seed()
})

describe('the worktree the strip belongs to', () => {
  // Two worktrees open; a tab from `w2` appearing here is the regression this guards.
  const twoWorktrees = (): void => {
    seed({
      activeWorktreeId: 'w1',
      layouts: {
        w1: layout('w1', row('t1', 't2'), 't1'),
        w2: layout('w2', row('t8', 't9'), 't8')
      },
      terminals: byId(
        terminal({ id: 't1', title: 'npm test' }),
        terminal({ id: 't2', agent: 'claude' }),
        terminal({ id: 't8', worktreeId: 'w2', title: 'deploy.sh' }),
        terminal({ id: 't9', worktreeId: 'w2', agent: 'codex' })
      )
    })
    mount()
  }

  it('lists the panes of the worktree you are in', () => {
    twoWorktrees()
    expect(tabNames()).toEqual(['npm test', 'Claude Code'])
  })

  it('lists nothing from any other worktree, however many are open', () => {
    twoWorktrees()
    expect(screen.queryByRole('tab', { name: 'deploy.sh' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Codex' })).toBeNull()
    expect(screen.queryByText('deploy.sh')).toBeNull()
    expect(screen.queryByText('Codex')).toBeNull()
  })

  // Tree order, not record order; built here to disagree.
  it('lists them in the order the split tree puts them, not the order the records arrived', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: {
        w1: layout(
          'w1',
          {
            kind: 'split',
            direction: 'row',
            sizes: [0.5, 0.5],
            children: [
              leaf('t1'),
              { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [leaf('t2'), leaf('t3')] }
            ]
          },
          't1'
        )
      },
      terminals: byId(
        terminal({ id: 't3', title: 'third' }),
        terminal({ id: 't1', title: 'first' }),
        terminal({ id: 't2', title: 'second' })
      )
    })
    mount()
    expect(tabNames()).toEqual(['first', 'second', 'third'])
  })

  // A leaf without its record still gets a tab, named as the board paints it.
  it('still gives a tab to a leaf whose terminal record has not arrived', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 'pending'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }))
    })
    mount()
    expect(tabNames()).toEqual(['npm test', 'terminal'])
  })

  // The sidebar's name, not a second one.
  it('calls a pane by the name of the agent running in it', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'ada@laptop: ~/repos', agent: 'claude' }))
    })
    mount()
    expect(screen.getByRole('tab', { name: 'Claude Code' })).toBeTruthy()
  })
})

describe('which tab is the selected one', () => {
  const selectedNames = (): (string | null)[] =>
    [...document.querySelectorAll('.tabs--active [role="tab"][aria-selected="true"]')].map((tab) =>
      tab.getAttribute('aria-label')
    )

  // Every group selects the tab it shows; the one holding the focus is the active group, as its pane has the keys.
  it('marks the group of the pane holding the focus active, its shown tab selected', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', agent: 'claude' }))
    })
    mount()
    expect(selectedNames()).toEqual(['Claude Code'])
    expect(document.querySelectorAll('.tabs--active')).toHaveLength(1)
  })

  // A watched pane holding focus marks no group, as `WorkspaceArea` draws no focused pane.
  it('marks no group at all while a teammate’s watched pane holds the focus', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', agent: 'claude' })),
      focusedWatchId: 'watch:p1:priya:t7'
    })
    mount()
    expect(selectedNames()).toEqual([])
    // The panes are still listed; it is only the focus that moved away.
    expect(tabNames()).toEqual(['npm test', 'Claude Code'])
  })
  // Zoomed, the pane filling the centre is the selected tab, whatever the focus says.
  it('selects the zoomed pane and no other while one fills the centre', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', agent: 'claude' })),
      expandedTerminalId: 't1'
    })
    mount()
    expect(tabNames()).toEqual(['npm test'])
    expect(screen.getByRole('tab', { name: 'npm test' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('what a tab does when it is pressed', () => {
  const twoPanes = (): void => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', agent: 'claude' }))
    })
    mount()
  }

  // A tab moves focus through the same action the chords and the pane click use.
  it('focuses that pane', () => {
    twoPanes()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    expect(focusPane).toHaveBeenCalledExactlyOnceWith('t2')
  })

  // `closeTerminal`, not a hide: a hidden-but-running pane has no leaf and no record.
  it('closes that pane, and the process in it, from the close button', () => {
    twoPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Close pane Claude Code' }))
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t2')
    expect(focusPane).not.toHaveBeenCalled()
  })

  // The accessible name is the only thing saying which pane the x closes.
  it('says which pane the close button closes, and that closing is what it does', () => {
    twoPanes()
    expect(screen.getByRole('button', { name: 'Close pane npm test' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close pane Claude Code' })).toBeTruthy()
  })
})

// The split and new-pane buttons live on the strip, next to the current pane they act on.
describe('the pane buttons at the end of the strip', () => {
  const onePane = (): void => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }))
    })
    mount()
  }

  it('splits the focused pane sideways', () => {
    onePane()
    fireEvent.click(screen.getByRole('button', { name: 'Split right' }))
    expect(splitFocusedPane).toHaveBeenCalledExactlyOnceWith('row')
  })

  it('splits the focused pane downwards', () => {
    onePane()
    fireEvent.click(screen.getByRole('button', { name: 'Split down' }))
    expect(splitFocusedPane).toHaveBeenCalledExactlyOnceWith('column')
  })

  // The `+` is a menu; the chord is still the one-press way to a terminal.
  it('opens the menu rather than a pane when pressed', () => {
    onePane()
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(screen.getByRole('menu', { name: 'New tab' })).toBeTruthy()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  // Hover names the action only; chords are taught elsewhere.
  it('names what each one does on hover, and no chord', () => {
    onePane()
    expect(screen.getByRole('button', { name: 'Split right' }).getAttribute('data-tip')).toBe('Split right')
    expect(screen.getByRole('button', { name: 'Split down' }).getAttribute('data-tip')).toBe('Split down')
    expect(screen.getByRole('button', { name: 'New tab' }).getAttribute('data-tip')).toBe('New tab')
  })

  it('carries no words of its own besides the tab names', () => {
    onePane()
    const strip = document.querySelector('.tabs') as HTMLElement
    const words = Array.from(strip.querySelectorAll('button')).map((button) => button.textContent?.trim() ?? '')
    expect(words.filter((text) => text.length > 0)).toEqual(['npm test'])
  })

  // Pinned to the strip's end in a group of their own, so a new tab never moves them.
  // The worktree's buttons in a group of their own at the head's end; a group's `+` at its strip's end.
  it('keeps the layout buttons at the head’s end, and each + at its strip’s end, after the tabs', () => {
    onePane()
    const head = document.querySelector('.workspace__head') as HTMLElement
    const strip = document.querySelector('.tabs') as HTMLElement
    const layout = screen.getByRole('button', { name: 'Split right' }).parentElement as HTMLElement
    expect(layout.classList.contains('tabs__layout')).toBe(true)
    for (const name of ['Maximize', 'Split right', 'Split down']) {
      expect(screen.getByRole('button', { name }).parentElement).toBe(layout)
    }
    expect(head.querySelector('.tabs__actions')?.lastElementChild).toBe(layout)
    expect(strip.contains(layout)).toBe(false)
    const plus = screen.getByRole('button', { name: 'New tab' })
    expect(strip.lastElementChild).toBe(plus)
    expect(screen.getByRole('tablist').contains(plus)).toBe(false)
  })

  it('says what each one does, for anything that cannot see the icon', () => {
    onePane()
    for (const name of ['Split right', 'Split down', 'New tab']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'New tab' }).getAttribute('aria-haspopup')).toBe('menu')
  })
})

// Maximize had only a menu row and a chord; the strip is where the pane buttons are seen.
describe('the Maximize button at the end of the strip', () => {
  const toggleExpandedPane = vi.fn()
  const twoPanes = (overrides: Record<string, unknown> = {}): void => {
    toggleExpandedPane.mockReset()
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', title: 'vim' })),
      toggleExpandedPane,
      ...overrides
    })
    mount()
  }

  it('maximizes the focused pane', () => {
    twoPanes()
    const button = screen.getByRole('button', { name: 'Maximize' })
    expect(button.getAttribute('data-tip')).toBe('Maximize')
    fireEvent.click(button)
    expect(toggleExpandedPane).toHaveBeenCalledOnce()
  })

  it('offers Restore while a pane fills the centre', () => {
    twoPanes({ expandedTerminalId: 't2' })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(toggleExpandedPane).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Maximize' })).toBeNull()
  })

  it('has nothing to maximize with one pane', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }))
    })
    mount()
    expect((screen.getByRole('button', { name: 'Maximize' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

// The `+` menu: a terminal, one row per agent `agent.list` found, then agent settings.
describe('the menu the + opens', () => {
  const onePane = (overrides: Record<string, unknown> = {}): void => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' })),
      agents: [claude, codex],
      ...overrides
    })
    mount()
  }

  const open = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    return screen.getByRole('menu', { name: 'New tab' })
  }

  /** The rows, top to bottom, by what a screen reader would call them. */
  const rows = (menu: HTMLElement): string[] =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.row-menu__label')?.textContent ?? '')

  const past: AgentConversation = { agent: 'claude', sessionId: 's1', prompt: 'fix it', updatedAt: 1, messages: 2 }

  it('lists a terminal, a markdown page, the agents the runtime found, and the agent settings', () => {
    onePane()
    expect(rows(open())).toEqual(['New Terminal', 'New Markdown', 'Claude Code', 'Codex', 'Agent Settings…'])
  })

  it('offers Resume Conversation… only once the worktree has a past conversation', () => {
    onePane({ conversations: { w1: [past] } })
    expect(rows(open())).toContain('Resume Conversation…')
    cleanup()
    onePane({ conversations: { w1: [] } })
    expect(rows(open())).not.toContain('Resume Conversation…')
  })

  it('asks for the worktree’s past conversations as it opens', () => {
    const loadConversations = vi.fn()
    onePane({ loadConversations })
    open()
    expect(loadConversations).toHaveBeenCalledWith('w1')
  })

  it('names the terminal chord on its row', () => {
    onePane()
    const terminalRow = within(open()).getByRole('menuitem', { name: 'New Terminal' })
    expect(terminalRow.querySelector('kbd')?.textContent).toBe('⌘T')
  })

  it('lists no agent the runtime did not find', () => {
    onePane({ agents: [claude] })
    expect(rows(open())).toEqual(['New Terminal', 'New Markdown', 'Claude Code', 'Agent Settings…'])
  })

  it('opens a markdown page in the worktree the strip belongs to', () => {
    const newMarkdown = vi.fn()
    onePane({ newMarkdown })
    fireEvent.click(within(open()).getByRole('menuitem', { name: /New Markdown/ }))
    expect(newMarkdown).toHaveBeenCalledExactlyOnceWith('w1')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('opens a terminal as a tab of the strip’s group, in its worktree', () => {
    onePane()
    fireEvent.click(within(open()).getByRole('menuitem', { name: 'New Terminal' }))
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith('w1', 't1')
    expect(startAgent).not.toHaveBeenCalled()
  })

  // The same store action the palette's "Start codex here" row calls.
  it('starts the chosen agent through the store as a tab of the group, and closes', () => {
    onePane()
    fireEvent.click(within(open()).getByRole('menuitem', { name: 'Codex' }))
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('codex', 't1')
    expect(createTerminal).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the settings at the agents section', () => {
    onePane()
    fireEvent.click(within(open()).getByRole('menuitem', { name: 'Agent Settings…' }))
    expect(openSettings).toHaveBeenCalledExactlyOnceWith('agents')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lands the keyboard on the first row, and arrows and Enter choose', () => {
    onePane()
    const menu = open()
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'New Terminal' }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: /New Markdown/ }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(startAgent).toHaveBeenCalledExactlyOnceWith('codex', 't1')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape and hands the focus back to the +', () => {
    onePane()
    const menu = open()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New tab' }))
    expect(startAgent).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('closes when the + is pressed again', () => {
    onePane()
    open()
    const plus = screen.getByRole('button', { name: 'New tab' })
    expect(plus.getAttribute('aria-expanded')).toBe('true')
    fireEvent.pointerDown(plus)
    fireEvent.click(plus)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(plus.getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves the split buttons as they were', () => {
    onePane()
    fireEvent.click(screen.getByRole('button', { name: 'Split right' }))
    expect(splitFocusedPane).toHaveBeenCalledExactlyOnceWith('row')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

// Renaming is what tells `claude`, `claude`, `claude` apart.
describe('naming a pane', () => {
  const threeAgents = (): void => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2', 't3'), 't1') },
      terminals: byId(
        terminal({ id: 't1', agent: 'claude', title: 'node' }),
        terminal({ id: 't2', agent: 'claude', title: 'node' }),
        terminal({ id: 't3', agent: 'claude', title: 'node', label: 'auth refactor' })
      )
    })
    mount()
  }

  it('tells two panes of the same agent apart, and calls the named one what it was named', () => {
    threeAgents()
    expect(tabNames()).toEqual(['Claude Code', 'Claude Code 2', 'auth refactor'])
    const drawn = screen.getAllByRole('tab').map((tab) => tab.querySelector('.tab__name')?.textContent)
    expect(drawn).toEqual(['Claude Code', 'Claude Code 2', 'auth refactor'])
  })

  // A button as well as double-click, so a name can be set without a mouse.
  it('opens the field from a button that says which pane it renames', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane Claude Code 2' }))
    expect(screen.getByRole('textbox', { name: 'Pane name' })).toBeTruthy()
  })

  // App-named panes have an empty stored label; the field used to open blank for them.
  it('opens the field holding the name the tab shows, selected', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane Claude Code' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' }) as HTMLInputElement
    expect(field.value).toBe('Claude Code')
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe('Claude Code'.length)
  })

  // Storing `claude 1` would freeze the number the strip made up.
  it('does not store the app’s own name back as a label', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane Claude Code' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renamePane).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Pane name' })).toBeNull()
  })

  it('renames from a double-click on the tab', () => {
    threeAgents()
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Claude Code' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.change(field, { target: { value: 'pager streaming' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renamePane).toHaveBeenCalledExactlyOnceWith('t1', 'pager streaming')
  })

  it('throws the typing away on Escape', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane Claude Code' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.change(field, { target: { value: 'never mind' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.blur(field)
    expect(renamePane).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Pane name' })).toBeNull()
  })

  // Blur commits: every other control in the strip takes focus away.
  it('keeps what was typed when the focus leaves the field', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane Claude Code' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.change(field, { target: { value: 'pager streaming' } })
    fireEvent.blur(field)
    expect(renamePane).toHaveBeenCalledExactlyOnceWith('t1', 'pager streaming')
  })

  // The stylesheet shortens it at the tab's widest, so a lone tab is not cut with the strip empty beside it.
  it('gives the tab the whole name to draw, and the hover text too', () => {
    const long = 'rewrite the pager so it streams instead of buffering'
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', agent: 'claude', label: long }))
    })
    mount()

    const tab = screen.getAllByRole('tab')[0]!
    expect(tab.querySelector('.tab__name')?.textContent).toBe(long)
    expect(tab.getAttribute('data-tip')).toContain(long)
  })

  it('says the harness and its state on the dot and the glyph', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', agent: 'claude', busy: true }))
    })
    mount()
    const tab = screen.getAllByRole('tab')[0]!
    expect(tab.querySelector('.activity')?.getAttribute('data-tip')).toBe('Claude Code · working')
    expect(tab.querySelector('.agent-glyph')?.getAttribute('data-tip')).toBe('Claude Code · working')
    expect(tab.querySelector('title')).toBeNull()
  })
})

// The strip is the window's top edge, so it holds the control that brings a hidden sidebar back.
describe('the head over the panes', () => {
  it('names the worktree, then its project and branch, once above every group', () => {
    seed({
      activeWorktreeId: 'w1',
      projects: [{ id: 'p1', name: 'shop', path: '/repos/shop' }],
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'session migration',
          branch: 'session-migration',
          path: '/w',
          state: 'ready'
        }
      ],
      layouts: { w1: layout('w1', row('t1', 't2'), 't1') },
      terminals: byId(terminal({ id: 't1' }), terminal({ id: 't2' }))
    })
    mount()
    const heads = document.querySelectorAll('.workspace__head')
    expect(heads).toHaveLength(1)
    expect(heads[0]!.textContent).toContain('session migration')
    expect(heads[0]!.textContent).toContain('shop · session-migration')
    expect(document.querySelectorAll('.tabs')).toHaveLength(2)
  })
})

describe('the way back to the sidebar', () => {
  it('offers to show the sidebar from the strip’s left end while it is hidden', () => {
    seed({ sidebarVisible: false })
    mount()
    const show = screen.getByRole('button', { name: 'Show sidebar' })
    expect(show.getAttribute('data-tip')).toBe('Show sidebar')
    expect(show.textContent).toBe('')
    expect(show.querySelector('svg')).toBeTruthy()
    expect(show.parentElement?.classList.contains('workspace__head')).toBe(true)
    expect(show.parentElement?.firstElementChild).toBe(show)
    fireEvent.click(show)
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })

  it('offers nothing of the kind while the sidebar is on screen', () => {
    seed({ sidebarVisible: true })
    mount()
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull()
  })

  // Still a head with nothing in it: the drag region and the expand control.
  it('keeps the head with nothing to list in it', () => {
    seed({ sidebarVisible: false })
    mount()
    expect(document.querySelector('.workspace__head')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy()
  })
})

describe('when there are no panes to list', () => {
  // The empty worktree view offers the same rows; the strip still has its end buttons.
  it('keeps the + and the splits in a worktree with no panes, with nothing to split', () => {
    seed({ activeWorktreeId: 'w1', layouts: { w1: layout('w1', null, null) }, agents: [claude] })
    mount()
    expect((screen.getByRole('button', { name: 'Split right' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Split down' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    expect(
      within(screen.getByRole('menu', { name: 'New tab' })).getByRole('menuitem', { name: 'Claude Code' })
    ).toBeTruthy()
  })

  it('offers no + while the checkout is still being prepared', () => {
    seed({
      activeWorktreeId: 'w1',
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'Rewrite the pager',
          branch: 'rewrite-the-pager',
          path: '/repos/pager-wt/rewrite',
          startedFrom: 'origin/main',
          state: 'creating',
          createdAt: 0
        }
      ]
    })
    mount()
    expect((screen.getByRole('button', { name: 'New tab' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has no end buttons with no worktree open, or while settings have the area', () => {
    seed()
    mount()
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull()
    cleanup()
    seed({ activeWorktreeId: 'w1', settingsOpen: true })
    mount()
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull()
  })

  // No tablist when empty; the strip itself stays.
  it('renders nothing when the worktree you are in has no layout yet', () => {
    seed({ activeWorktreeId: 'w1', terminals: byId(terminal({ id: 't1', title: 'npm test' })) })
    mount()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('renders nothing when the layout has no panes left in it', () => {
    seed({ activeWorktreeId: 'w1', layouts: { w1: layout('w1', null, null) } })
    mount()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  // No active worktree, no session to list, even with other worktrees' terminals in the store.
  it('renders nothing when no worktree is open at all', () => {
    seed({
      layouts: { w2: layout('w2', row('t8'), 't8') },
      terminals: byId(terminal({ id: 't8', worktreeId: 'w2', title: 'deploy.sh' }))
    })
    mount()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText('deploy.sh')).toBeNull()
  })
})

// The sidebar's unread mark, on the same panes.
describe('panes that have printed since they were read', () => {
  it('marks the tab of a pane that spoke while another had the focus', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(
        terminal({ id: 't1', title: 'claude', lastOutputAt: 5_000 }),
        terminal({ id: 't2', title: 'npm test', lastOutputAt: 5_000 })
      ),
      paneSeenAt: { t1: 1_000, t2: 1_000 }
    })
    mount()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.find((tab) => tab.textContent?.includes('claude'))?.closest('.tab')?.className).toContain('tab--unread')
    // The one being looked at is never unread, however much it prints.
    expect(tabs.find((tab) => tab.textContent?.includes('npm test'))?.closest('.tab')?.className).not.toContain(
      'tab--unread'
    )
    const spoke = tabs.find((tab) => tab.textContent?.includes('claude'))
    expect(spoke?.querySelectorAll('.activity, .pip')).toHaveLength(1)
    // Unread is the name's weight; the dot says the state alone.
    expect(spoke?.querySelector('.activity')?.className).not.toContain('unread')
  })

  it('leaves a pane alone when nothing has arrived since it was read', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'claude', lastOutputAt: 1_000 })),
      paneSeenAt: { t1: 5_000 }
    })
    mount()

    expect(screen.getByRole('tab', { name: /claude/ }).closest('.tab')?.className).not.toContain('tab--unread')
  })
})

describe('a markdown tab', () => {
  const nameMarkdown = vi.fn()
  const withPage = (overrides: Record<string, unknown> = {}): void => {
    seed({
      activeWorktreeId: 'w1',
      layouts: {
        w1: layout(
          'w1',
          {
            kind: 'split',
            direction: 'row',
            sizes: [0.5, 0.5],
            children: [leaf('t1'), { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'docs/NOTES.md' }]
          },
          'file:1'
        )
      },
      terminals: byId(terminal({ id: 't1', title: 'npm test' })),
      nameMarkdown,
      ...overrides
    })
    mount()
  }

  it('is named after its file, beside the terminals, and is the selected one when its pane has the focus', () => {
    withPage()
    expect(tabNames()).toEqual(['npm test', 'NOTES.md'])
    expect(screen.getByRole('tab', { name: /NOTES\.md/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Rename pane NOTES.md' })).toBeNull()
  })

  it('shows a dot while the page is ahead of the file, and none once it is saved', () => {
    withPage({ unsavedFiles: { 'file:1': true } })
    expect(screen.getByTestId('unsaved')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /NOTES\.md/ }).getAttribute('data-tip')).toBe('NOTES.md · unsaved')
    act(() => useWorkspaceStore.setState({ unsavedFiles: {} }))
    expect(screen.queryByTestId('unsaved')).toBeNull()
  })

  it('asks for the next file’s name in the strip, and hands it to the store', () => {
    withPage({ namingMarkdown: 'w1' })
    const field = screen.getByRole('textbox', { name: 'File name' })
    fireEvent.change(field, { target: { value: 'plan' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(nameMarkdown).toHaveBeenCalledWith('plan')
  })

  it('closes through the same close the terminals use', () => {
    withPage()
    fireEvent.click(screen.getByRole('button', { name: 'Close pane NOTES.md' }))
    expect(closeTerminal).toHaveBeenCalledWith('file:1')
  })
})

// A page has its own head; an empty strip over it is a band of nothing.
describe('over a page', () => {
  it.each([
    ['Settings', { settingsOpen: true }],
    ['Teamwork', { teamworkProjectId: 'p1' }],
    ['Help', { helpOpen: true }]
  ])('draws no strip over %s while the sidebar holds the window buttons', (_page, state) => {
    seed({ activeWorktreeId: 'w1', layouts: { w1: layout('w1', row('t1'), 't1') }, ...state })
    const { container } = render(<Strips />)
    expect(container.querySelector('.tabs')).toBeNull()
  })

  it('draws no strip over Settings with the sidebar put away, since Settings has the window', () => {
    seed({ sidebarVisible: false, settingsOpen: true })
    const { container } = render(<Strips />)
    expect(container.querySelector('.tabs')).toBeNull()
  })

  it('keeps the strip over a page for the Show sidebar button while the sidebar is away', () => {
    seed({ sidebarVisible: false, teamworkProjectId: 'p1' })
    mount()
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy()
  })
})

// A group narrower than its shown tab drew a bare `+1` and no tab at all.
describe('a strip too narrow for its tabs', () => {
  const tab = (left: number, width: number, active = false): HTMLElement => {
    const element = document.createElement('div')
    element.className = active ? 'tab tab--active' : 'tab'
    element.dataset.paneId = String(left)
    Object.defineProperties(element, { offsetLeft: { value: left }, offsetWidth: { value: width } })
    return element
  }

  it('cuts the tabs out of sight, never the shown one', () => {
    const strip = document.createElement('div')
    const shown = tab(0, 200, true)
    const other = tab(200, 120)
    strip.append(shown, other)
    Object.defineProperties(strip, {
      scrollWidth: { value: 320 },
      clientWidth: { value: 150 },
      scrollLeft: { value: 0 }
    })
    expect(cutTabsOutOfView(strip)).toBe(1)
    expect(shown.hasAttribute('data-cut')).toBe(false)
    expect(other.hasAttribute('data-cut')).toBe(true)
  })
})

// The welcome and an empty project drew a bare band over the page: with no worktree, the head is only the drag edge.
describe('the head with no worktree open', () => {
  it('draws no band, only the edge the window is dragged by', () => {
    seed({ activeWorktreeId: null })
    mount()
    expect(document.querySelector('.workspace__head')?.className).toBe('workspace__head workspace__head--bare')
    cleanup()
    seed({
      activeWorktreeId: 'w1',
      worktrees: [{ id: 'w1', projectId: 'p1', name: 'session migration', branch: 'b', path: '/w', state: 'ready' }]
    })
    mount()
    expect(document.querySelector('.workspace__head')?.className).toBe('workspace__head')
  })
})

// After a quit or a crash, every agent was brought back by hand, one pane at a time.
describe('Resume All in the head', () => {
  const ended = (id: string, extra: Partial<Terminal> = {}): Terminal =>
    terminal({ id, agent: 'claude', running: false, exitCode: 1, ...extra })

  it('resumes every ended agent here that can pick its conversation back up, and only those', () => {
    const resumeAgents = vi.fn(async () => {})
    seed({
      activeWorktreeId: 'w1',
      resumeAgents,
      layouts: { w1: layout('w1', row('t1', 't2', 't3'), 't1') },
      terminals: byId(
        ended('t1', { resumable: true }),
        ended('t2', { resumable: true }),
        ended('t3'),
        ended('t9', { worktreeId: 'w2', resumable: true })
      )
    })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Resume All' }))
    expect(resumeAgents).toHaveBeenCalledExactlyOnceWith(['t1', 't2'])
  })

  it('is not there for one, or none', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't1') },
      terminals: byId(ended('t1', { resumable: true }), ended('t2'))
    })
    mount()
    expect(screen.queryByRole('button', { name: 'Resume All' })).toBeNull()
  })
})
