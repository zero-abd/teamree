/** @vitest-environment jsdom */

// The strip along the top of the workspace, and the one promise it makes.
//
// What used to be here was a tab per open worktree: a second and worse copy of
// the sidebar's middle level, mixing the panes of every worktree somebody had
// opened into one row. The strip now belongs to the worktree you are in, and
// most of this file is about that boundary holding — a tab from another
// worktree appearing here is the exact complaint the change answers, and it
// must fail loudly rather than quietly re-arrive.
//
// Then there being one answer to where the next keystroke goes. The selected
// tab is read from the same `focusedTerminalId` the focused pane border is read
// from, and a teammate's watched pane holding the focus means no tab of yours is
// selected. Two selected things would be two answers.
//
// And the three buttons at the end of it, which are the only place in the
// window a pane can be split or opened with a pointer. They were in the
// worktree header, above this strip, beside a filesystem path and the pane
// board — four commands in a row, every one of them with a home elsewhere. The
// tests below say where they are now and what they act on, so a tidy-up cannot
// leave the window with no clickable way to split a pane at all.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, PaneNode, Terminal } from '@shared/entities'
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
const { TerminalTabs } = await import('./TerminalTabs')

const INITIAL = useWorkspaceStore.getState()

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

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    { ...INITIAL, focusPane, closeTerminal, createTerminal, splitFocusedPane, renamePane, toggleSidebar, ...overrides },
    true
  )
}

const mount = (): void => {
  render(<TerminalTabs />)
}

/** The names on the strip, in the order it puts them. */
const tabNames = (): (string | null)[] => screen.getAllByRole('tab').map((tab) => tab.textContent)

beforeEach(() => {
  focusPane.mockReset()
  closeTerminal.mockReset()
  createTerminal.mockReset()
  splitFocusedPane.mockReset()
  renamePane.mockReset()
  toggleSidebar.mockReset()
  seed()
})

describe('the worktree the strip belongs to', () => {
  // Two worktrees open, each with panes of its own, and only one of them is the
  // one somebody is looking at. This is the whole complaint the change answers:
  // the old strip listed every open worktree at once, so the row above the
  // panes described sessions that were not on screen. If a tab from `w2` ever
  // shows up here again, this is the test that has to stop it.
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
    expect(tabNames()).toEqual(['npm test', 'claude'])
  })

  it('lists nothing from any other worktree, however many are open', () => {
    twoWorktrees()
    expect(screen.queryByRole('tab', { name: 'deploy.sh' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'codex' })).toBeNull()
    expect(screen.queryByText('deploy.sh')).toBeNull()
    expect(screen.queryByText('codex')).toBeNull()
  })

  // The tree is the order the panes read on screen, and the order
  // `focus-next-pane` steps through them. The records are keyed by id and carry
  // no order worth sorting a strip by, so the two are built here to disagree.
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

  // The board paints 'terminal' on the bar of a pane whose record has not come
  // back yet, and the strip is a directory of the board. A directory that lists
  // one entry fewer than the thing it describes teaches a reader to stop
  // trusting it.
  it('still gives a tab to a leaf whose terminal record has not arrived', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 'pending'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }))
    })
    mount()
    expect(tabNames()).toEqual(['npm test', 'terminal'])
  })

  // The sidebar calls this pane `claude`, and so does the strip. A pane named
  // two things in one window is two answers about one pane, and nothing on
  // screen says which of them the app believes.
  it('calls a pane by the name of the agent running in it', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', title: 'ada@laptop: ~/repos', agent: 'claude' }))
    })
    mount()
    expect(screen.getByRole('tab', { name: 'claude' })).toBeTruthy()
  })
})

describe('which tab is the selected one', () => {
  const selectedNames = (): (string | null)[] =>
    screen
      .getAllByRole('tab')
      .filter((tab) => tab.getAttribute('aria-selected') === 'true')
      .map((tab) => tab.textContent)

  // One fact painted twice: the tab marked selected and the border drawn round
  // a pane are both `layout.focusedTerminalId`, so the strip and the board can
  // never disagree about where typing lands.
  it('selects the tab of the pane holding the focus', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', agent: 'claude' }))
    })
    mount()
    expect(selectedNames()).toEqual(['claude'])
  })

  // A teammate's watched pane is what takes the focus off every pane of yours,
  // and the strip has to say so by selecting nothing. A selected tab beside a
  // focused border somewhere else would be the second answer this arrangement
  // exists to avoid — and it is the same test `WorkspaceArea` applies before it
  // hands a focused id to the pane tree.
  it('selects no tab at all while a teammate’s watched pane holds the focus', () => {
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1', 't2'), 't2') },
      terminals: byId(terminal({ id: 't1', title: 'npm test' }), terminal({ id: 't2', agent: 'claude' })),
      focusedWatchId: 'watch:p1:priya:t7'
    })
    mount()
    expect(selectedNames()).toEqual([])
    // The panes are still listed; it is only the selection that moved away.
    expect(tabNames()).toEqual(['npm test', 'claude'])
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

  // A tab is a jump to a pane, not a choice of which pane to show: every leaf
  // of a split tree is on screen at once, so there is no visibility for a tab
  // to own. What it can do is move the focus, and it moves it through the same
  // action the chords and the pane click use.
  it('focuses that pane', () => {
    twoPanes()
    fireEvent.click(screen.getByRole('tab', { name: 'claude' }))
    expect(focusPane).toHaveBeenCalledExactlyOnceWith('t2')
  })

  // `closeTerminal` and not some softer hide, because there is exactly one
  // process behind a tab and behind the pane it names, and it is the same
  // close the pane's own bar offers. A tab that hid a pane while its pty ran on
  // would invent a state the layout tree has no leaf for, the runtime has no
  // record of, and `teamree terminal list` has no word for: a pane nobody can
  // see and nobody can reach, still holding a shell.
  it('closes that pane, and the process in it, from the close button', () => {
    twoPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Close pane claude' }))
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t2')
    expect(focusPane).not.toHaveBeenCalled()
  })

  // The button is an x in a strip of them, so the only thing that says which
  // pane it throws away is its accessible name.
  it('says which pane the close button closes, and that closing is what it does', () => {
    twoPanes()
    expect(screen.getByRole('button', { name: 'Close pane npm test' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close pane claude' })).toBeTruthy()
  })
})

// Four buttons used to sit in the header above this strip: a pane board, two
// splits and a new terminal. The board belongs to the rail, and these three
// belong here — on the strip that already draws which pane is current, which is
// the pane every one of them acts on.
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

  it('opens a pane in the worktree the strip belongs to', () => {
    onePane()
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith('w1')
  })

  // They are icons, so the hover names what they do — and only that. The
  // chords are taught in the menu bar, in Help, in the palette and on the
  // front door; a fifth place was the strip explaining itself.
  it('names what each one does on hover, and no chord', () => {
    onePane()
    expect(screen.getByRole('button', { name: 'Split right' }).getAttribute('title')).toBe('Split right')
    expect(screen.getByRole('button', { name: 'Split down' }).getAttribute('title')).toBe('Split down')
    expect(screen.getByRole('button', { name: 'New terminal' }).getAttribute('title')).toBe('New terminal')
  })

  it('carries no words of its own besides the tab names', () => {
    onePane()
    const strip = document.querySelector('.tabs') as HTMLElement
    const words = Array.from(strip.querySelectorAll('button')).map((button) => button.textContent?.trim() ?? '')
    expect(words.filter((text) => text.length > 0)).toEqual(['npm test'])
  })

  // An icon with no label is a button nothing on screen names, and a screen
  // reader would read three of them as "button, button, button".
  it('says what each one does, for anything that cannot see the icon', () => {
    onePane()
    for (const name of ['Split right', 'Split down', 'New terminal']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })
})

// The gap the whole feature is for: three agents started on three approaches
// read `claude`, `claude`, `claude`, and the strip is what somebody is looking
// at when they wish one of them said which was the auth refactor.
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
    expect(tabNames()).toEqual(['claude 1', 'claude 2', 'auth refactor'])
  })

  // A button rather than a double-click alone: a name is the one thing on this
  // strip somebody has to be able to set without a mouse.
  it('opens the field from a button that says which pane it renames', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane claude 2' }))
    expect(screen.getByRole('textbox', { name: 'Pane name' })).toBeTruthy()
  })

  // The panes a person renames are exactly the ones the app named, and the
  // field opened empty for those: the strip drew `claude 1`, the field read the
  // stored label, and there was none.
  it('opens the field holding the name the tab shows, selected', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane claude 1' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' }) as HTMLInputElement
    expect(field.value).toBe('claude 1')
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe('claude 1'.length)
  })

  // Enter on the untouched field is not a rename: storing `claude 1` as a
  // label would freeze the number the strip made up.
  it('does not store the app’s own name back as a label', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane claude 1' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renamePane).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Pane name' })).toBeNull()
  })

  it('renames from a double-click on the tab', () => {
    threeAgents()
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'claude 1' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.change(field, { target: { value: 'pager streaming' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renamePane).toHaveBeenCalledExactlyOnceWith('t1', 'pager streaming')
  })

  it('throws the typing away on Escape', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane claude 1' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.change(field, { target: { value: 'never mind' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.blur(field)
    expect(renamePane).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Pane name' })).toBeNull()
  })

  // The field sits in a strip whose every other control takes the focus away,
  // and a name thrown away because somebody reached for the pane they were
  // naming would be the worst of the three possible answers.
  it('keeps what was typed when the focus leaves the field', () => {
    threeAgents()
    fireEvent.click(screen.getByRole('button', { name: 'Rename pane claude 1' }))
    const field = screen.getByRole('textbox', { name: 'Pane name' })
    fireEvent.change(field, { target: { value: 'pager streaming' } })
    fireEvent.blur(field)
    expect(renamePane).toHaveBeenCalledExactlyOnceWith('t1', 'pager streaming')
  })

  // Shortened where it is drawn and nowhere behind it: the tooltip and the
  // record both still have the whole of what somebody typed.
  it('shortens a long name on the tab and keeps all of it in the hover text', () => {
    const long = 'rewrite the pager so it streams instead of buffering'
    seed({
      activeWorktreeId: 'w1',
      layouts: { w1: layout('w1', row('t1'), 't1') },
      terminals: byId(terminal({ id: 't1', agent: 'claude', label: long }))
    })
    mount()

    const tab = screen.getAllByRole('tab')[0]!
    expect(tab.textContent).not.toBe(long)
    expect(tab.textContent?.endsWith('…')).toBe(true)
    expect(tab.getAttribute('title')).toContain(long)
  })
})

// The strip is the top edge of the window's main column now — the row the
// macOS window buttons sit on once the sidebar is away — so it is also the
// only place a sidebar that has been hidden can be brought back with a pointer.
describe('the way back to the sidebar', () => {
  it('offers to show the sidebar from the strip’s left end while it is hidden', () => {
    seed({ sidebarVisible: false })
    mount()
    const show = screen.getByRole('button', { name: 'Show sidebar' })
    expect(show.getAttribute('title')).toBe('Show sidebar')
    expect(show.textContent).toBe('')
    expect(show.querySelector('svg')).toBeTruthy()
    expect(show.parentElement?.classList.contains('tabs')).toBe(true)
    expect(show.parentElement?.firstElementChild).toBe(show)
    fireEvent.click(show)
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })

  it('offers nothing of the kind while the sidebar is on screen', () => {
    seed({ sidebarVisible: true })
    mount()
    expect(screen.queryByRole('button', { name: 'Show sidebar' })).toBeNull()
  })

  // No worktree, no panes, and still a strip: with nothing in it, it is what
  // the window is dragged by and what the expand control sits in.
  it('keeps the strip with nothing to list in it', () => {
    seed({ sidebarVisible: false })
    mount()
    expect(document.querySelector('.tabs')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy()
  })
})

describe('when there are no panes to list', () => {
  // An empty strip lists nothing: a `role="tablist"` labelled "Terminals in
  // this worktree" above a worktree with nothing in it announces a region that
  // has nothing to announce. The strip itself stays, because it is the window's
  // top edge, but the list and the pane buttons in it do not.
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

  // Terminals from worktrees that are open but not the one being looked at are
  // still in the store. With no active worktree there is no session for the
  // strip to be a directory of, and listing those would be the old behaviour.
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

// The mark the sidebar draws, on the same panes and read the same way: a pane
// that has printed since this person last had it in front of them. The strip is
// what somebody is looking at while an agent works beside them in the next
// pane, so it is where a tab going quietly unread would cost the most.
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
