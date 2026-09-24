/** @vitest-environment jsdom */

// A window too narrow for its panes folds the right panel, then the sidebar, and brings them back;
// a pane it cannot make room for is refused with one notice that names the fix.

import { beforeEach, expect, it, vi } from 'vitest'

const measurement = vi.hoisted(() => ({
  grid: undefined as { area: unknown; minPane: unknown; cell: unknown } | undefined
}))

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

vi.mock('../terminal/paneMetrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/paneMetrics')>()
  return {
    ...actual,
    newPaneRoom: () => 'full' as const,
    paneGrid: () => measurement.grid
  }
})

import { useWorkspaceStore } from './workspaceStore'

const NO_ROOM = 'No room for another pane'

beforeEach(() => {
  measurement.grid = undefined
  useWorkspaceStore.setState({
    notices: [],
    rightPanelOpen: true,
    rightPanelWidth: 340,
    sidebarVisible: true,
    roomHid: { panel: false, sidebar: false }
  })
  localStorage.clear()
})

async function openedWorktree(): Promise<string> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  const focused = useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId!
  useWorkspaceStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [worktreeId]: { worktreeId, root: { kind: 'leaf', terminalId: focused }, focusedTerminalId: focused }
    }
  }))
  return worktreeId
}

it('says a refused pane once, however often it is asked for', async () => {
  const worktreeId = await openedWorktree()
  for (let i = 0; i < 3; i++) await useWorkspaceStore.getState().createTerminal(worktreeId)
  expect(useWorkspaceStore.getState().notices.filter((notice) => notice.text === NO_ROOM)).toHaveLength(1)
})

it('offers to hide the panel when that makes room, and hides it', async () => {
  const worktreeId = await openedWorktree()
  // One pane in 400x300 splits neither way above 337x181; 311 more pixels across and it does.
  measurement.grid = {
    area: { width: 400, height: 300 },
    minPane: { width: 337, height: 181 },
    cell: { width: 8, height: 17 }
  }
  await useWorkspaceStore.getState().createTerminal(worktreeId)

  const notice = useWorkspaceStore.getState().notices.at(-1)!
  expect(notice).toMatchObject({ text: NO_ROOM, action: { label: 'Hide panel', hide: 'panel' } })

  useWorkspaceStore.getState().hideRegion('panel')
  expect(useWorkspaceStore.getState().rightPanelOpen).toBe(false)
  useWorkspaceStore.getState().hideRegion('panel')
  expect(useWorkspaceStore.getState().rightPanelOpen).toBe(false)
})

it('offers nothing when hiding the panel would not make room either', async () => {
  const worktreeId = await openedWorktree()
  measurement.grid = {
    area: { width: 200, height: 300 },
    minPane: { width: 337, height: 181 },
    cell: { width: 8, height: 17 }
  }
  useWorkspaceStore.setState({ sidebarVisible: false })
  await useWorkspaceStore.getState().createTerminal(worktreeId)
  expect(useWorkspaceStore.getState().notices.at(-1)).toMatchObject({ text: NO_ROOM })
  expect(useWorkspaceStore.getState().notices.at(-1)?.action).toBeUndefined()
})

it('folds the panel for room without forgetting it was open, and brings it back', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({
    rightPanelOpen: false,
    roomHid: { panel: true, sidebar: false }
  })
  // The habit on disk is still an open panel: the next launch in a wide window shows it.
  expect(localStorage.getItem('teamree.shell.rightPanel')).toBeNull()

  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({
    rightPanelOpen: true,
    roomHid: { panel: false, sidebar: false }
  })
})

it('hides the sidebar for room but remembers it as shown', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: true })
  expect(useWorkspaceStore.getState()).toMatchObject({ sidebarVisible: false, rightPanelOpen: false })
  expect(JSON.parse(localStorage.getItem('teamree.workspace.session') ?? '{}').sidebarVisible).toBe(true)

  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({ sidebarVisible: true, rightPanelOpen: true })
})

it('keeps the panel folded when the sidebar is hidden by hand for room', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: false })
  useWorkspaceStore.getState().hideRegion('sidebar')
  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: false, sidebarVisible: false })
})

it('leaves a panel somebody reopened by hand alone', () => {
  useWorkspaceStore.getState().makeRoom({ panel: true, sidebar: false })
  useWorkspaceStore.getState().toggleRightPanel()
  expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: true, roomHid: { panel: false } })
  // Room coming back has nothing of its own to restore.
  useWorkspaceStore.getState().toggleRightPanel()
  useWorkspaceStore.getState().makeRoom({ panel: false, sidebar: false })
  expect(useWorkspaceStore.getState().rightPanelOpen).toBe(false)
})
