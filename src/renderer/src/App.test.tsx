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
  ConfirmRemoveDialog: ({ reason }: { reason: string }) => <div data-testid="confirm-remove">{reason}</div>
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

  it('carries the runtime’s refusal into the confirmation it caused', () => {
    const reason = 'this worktree has 3 uncommitted changes'
    seed({ dialog: { kind: 'confirm-remove', worktreeId: 'w1', reason, intent: 'remove' } })
    render(<App />)
    expect(screen.getByTestId('confirm-remove').textContent).toBe(reason)
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
})
