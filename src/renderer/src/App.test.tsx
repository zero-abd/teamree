/** @vitest-environment jsdom */

// The shell, for the two things only it owns: the notice layer, which is where
// every refusal the runtime raises outside a dialog ends up, and which dialog
// is on screen.
//
// Notices are the least-exercised surface in the app and the most user-visible
// when they matter — a failed push, a worktree that could not be removed, a
// pane that would not open. They are announced rather than merely drawn, and
// they are dismissible one at a time; both are properties of the rendered
// layer and of nothing else.
//
// Everything below the shell is replaced by a marker. Each has its own file,
// and none of them decides what the shell decides.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./runtimeClient/currentRuntimeClient', () => ({
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

const marker = (name: string) => () => <div data-testid={name} />

vi.mock('./sidebar/Sidebar', () => ({ Sidebar: marker('sidebar') }))
vi.mock('./workspace/WorkspaceArea', () => ({ WorkspaceArea: marker('workspace') }))
vi.mock('./shell/StatusBar', () => ({ StatusBar: marker('statusbar') }))
vi.mock('./shell/SidebarResizer', () => ({ SidebarResizer: marker('resizer') }))
vi.mock('./dialogs/FirstRunCliOffer', () => ({ FirstRunCliOffer: () => null }))
vi.mock('./palette/CommandPalette', () => ({ CommandPalette: marker('palette') }))
vi.mock('./dialogs/AddProjectDialog', () => ({ AddProjectDialog: marker('add-project') }))
vi.mock('./dialogs/InstallCliDialog', () => ({ InstallCliDialog: marker('install-cli') }))
vi.mock('./dialogs/TaskComposerDialog', () => ({
  TaskComposerDialog: ({ projectId }: { projectId: string }) => <div data-testid="new-task">{projectId}</div>
}))
vi.mock('./dialogs/ConfirmRemoveDialog', () => ({
  ConfirmRemoveDialog: ({ worktreeId }: { worktreeId: string }) => <div data-testid="confirm-remove">{worktreeId}</div>
}))

const { useWorkspaceStore } = await import('./state/workspaceStore')
const { App } = await import('./App')

const INITIAL = useWorkspaceStore.getState()

const dismissNotice = vi.fn()
const startWatching = vi.fn(() => () => {})
const bootstrap = vi.fn(async () => {})

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState({ ...INITIAL, dismissNotice, startWatching, bootstrap, ...overrides }, true)
}

beforeEach(() => {
  dismissNotice.mockReset()
  startWatching.mockClear()
  bootstrap.mockClear()
  seed()
})

describe('the notice layer', () => {
  it('is absent while there is nothing to say', () => {
    render(<App />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  // Announced, not merely drawn: a refusal that only appears in a corner is one
  // a screen reader never hears about.
  it('announces what it shows, politely rather than by interrupting', () => {
    seed({ notices: [{ id: 1, text: 'git push was rejected: fetch first', tone: 'error' }] })
    render(<App />)
    const layer = screen.getByRole('status')
    expect(layer.getAttribute('aria-live')).toBe('polite')
    expect(within(layer).getByText('git push was rejected: fetch first')).toBeTruthy()
  })

  it('shows every notice, and dismisses the one that was pressed', () => {
    seed({
      notices: [
        { id: 1, text: 'git push was rejected: fetch first', tone: 'error' },
        { id: 2, text: 'Linked /usr/local/bin/teamree', tone: 'info' }
      ]
    })
    render(<App />)
    const buttons = screen.getAllByRole('button', { name: 'Dismiss message' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1] as HTMLElement)
    expect(dismissNotice).toHaveBeenCalledExactlyOnceWith(2)
  })

  // A push that made a review possible says so where the push result is said,
  // and the button is the whole offer: a verb, and the address behind it.
  it('offers the one thing a notice can do, and opens it beside the app', () => {
    const url = 'https://github.com/o/r/compare/main...work?expand=1'
    const opened: Array<string | undefined> = []
    vi.stubGlobal(
      'open',
      vi.fn((target?: string | URL) => {
        opened.push(typeof target === 'string' ? target : target?.toString())
        return null
      })
    )
    seed({
      notices: [
        {
          id: 1,
          text: 'Pushed work to origin · now tracking origin/work',
          tone: 'info',
          action: { label: 'Open review', url }
        }
      ]
    })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    // `window.open`, which is the window's one way to the browser — the main
    // process decides what is handed to the OS, once, in windowNavigation.ts.
    expect(opened).toEqual([url])
    vi.unstubAllGlobals()
  })

  it('offers nothing to do when the notice carries no action', () => {
    seed({ notices: [{ id: 1, text: 'Pushed work to origin', tone: 'info' }] })
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Open review' })).toBeNull()
  })
})

describe('which dialog is on screen', () => {
  it('shows none of them by default', () => {
    render(<App />)
    for (const kind of ['palette', 'add-project', 'install-cli', 'new-task', 'confirm-remove']) {
      expect(screen.queryByTestId(kind)).toBeNull()
    }
  })

  it('opens exactly the one the store names, and hands it what it needs', () => {
    seed({ dialog: { kind: 'new-task', projectId: 'p1' } })
    render(<App />)
    expect(screen.getByTestId('new-task').textContent).toBe('p1')
    expect(screen.queryByTestId('add-project')).toBeNull()
  })

  it('hands the removal question its worktree', () => {
    seed({ dialog: { kind: 'confirm-remove', worktreeId: 'w1', intent: 'remove' } })
    render(<App />)
    expect(screen.getByTestId('confirm-remove').textContent).toBe('w1')
  })
})

// Two modals can be on screen at once, and only since a question about a
// teammate's keystrokes stopped being this window's own business. Everything
// that makes that survivable — which one is painted on top, and which one owns
// the keyboard — is decided by the order they are rendered in, and nothing
// about it is visible in either component.
describe('a question that arrives while something else is open', () => {
  const question = {
    id: 'ask_1',
    projectId: 'p1',
    terminalId: 't_7',
    handle: 'priya',
    publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
    since: 1_000,
    at: 1_500,
    expiresAt: Date.now() + 60_000,
    writes: 4,
    bytes: 4,
    preview: 'npm test',
    clipped: false
  }

  const asking = { consent: { p1: { projectId: 'p1', requests: [question], standing: [], readAt: 1 } } }

  it('is on screen even with a dialog of this window’s own open', () => {
    seed({ ...asking, dialog: { kind: 'confirm-discard', worktreeId: 'w1', path: 'a.ts' } })
    render(<App />)
    expect(screen.getByRole('dialog', { name: 'priya wants to type in t_7' })).toBeTruthy()
    // And the confirm is still open underneath, unanswered rather than
    // closed: it is this person's own half-finished work, and they did not
    // abandon it.
    expect(screen.getByRole('dialog', { name: 'Discard changes to a.ts?' })).toBeTruthy()
  })

  // Both layers carry the same z-index, so which is in front is decided by the
  // order they are written in and by nothing else. A question about bytes that
  // are about to run as this user outranks anything this user has half-finished.
  it('is painted over it, rather than under it', () => {
    seed({ ...asking, dialog: { kind: 'confirm-discard', worktreeId: 'w1', path: 'a.ts' } })
    const { container } = render(<App />)
    const layers = [...container.querySelectorAll('.modal-layer')]
    expect(layers).toHaveLength(2)
    expect(layers.at(-1)?.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'priya wants to type in t_7'
    )
  })
})

describe('the shell itself', () => {
  // Started before the first read, because an event that arrives during
  // bootstrap must not be missed.
  it('starts watching the workspace before it reads it, and stops on unmount', () => {
    const stop = vi.fn()
    startWatching.mockReturnValue(stop)
    const { unmount } = render(<App />)
    expect(startWatching).toHaveBeenCalledOnce()
    expect(bootstrap).toHaveBeenCalledOnce()
    expect(startWatching.mock.invocationCallOrder[0]).toBeLessThan(bootstrap.mock.invocationCallOrder[0] as number)
    unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('hides the sidebar without hiding the workspace', () => {
    seed({ sidebarVisible: false })
    render(<App />)
    expect(screen.queryByTestId('sidebar')).toBeNull()
    expect(screen.getByTestId('workspace')).toBeTruthy()
  })

  // There used to be a strip across the whole top of the window carrying the
  // app's name. The sidebar and the pane strip are the top edge now, and the
  // name is the sidebar's to draw — which is why, with the sidebar replaced by
  // a marker here, the shell must not be printing it anywhere itself.
  it('draws no strip of its own across the top, and leaves the name to the sidebar', () => {
    const { container } = render(<App />)
    expect(container.querySelector('.titlebar')).toBeNull()
    expect(container.querySelector('header')).toBeNull()
    expect(screen.queryByText('teamree')).toBeNull()
  })

  // The stylesheet moves the macOS window-button inset from the sidebar's
  // header to the pane strip on this one class, so the strip is never drawn
  // under the buttons.
  it('says on the shell when the sidebar is away', () => {
    seed({ sidebarVisible: false })
    const { container } = render(<App />)
    expect(container.firstElementChild?.classList.contains('shell--collapsed')).toBe(true)
  })
})
