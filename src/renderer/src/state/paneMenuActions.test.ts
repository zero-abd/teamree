// What the pane menu asks of the store: Close Others through the same question one close asks,
// and Maximize and Rename aimed at the pane pointed at rather than the focused one.

import { describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@shared/entities'
import { collectTerminalIds, leaf } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { showPane } from '../terminal/shownPanes'
import { useWorkspaceStore } from './workspaceStore'

/** A ready worktree whose tree is `count` fresh panes in a row and nothing else. */
async function panes(count: number): Promise<{ worktreeId: string; ids: string[] }> {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  const before = new Set(Object.keys(useWorkspaceStore.getState().terminals))
  for (let made = 0; made < count; made++) await useWorkspaceStore.getState().createTerminal(worktreeId)
  const ids = Object.keys(useWorkspaceStore.getState().terminals).filter((id) => !before.has(id))
  const root: PaneNode = { kind: 'split', direction: 'row', sizes: ids.map(() => 1 / count), children: ids.map(leaf) }
  useWorkspaceStore.setState((state) => ({
    dialog: null,
    expandedTerminalId: null,
    layouts: { ...state.layouts, [worktreeId]: { worktreeId, root, focusedTerminalId: ids[0] ?? null } }
  }))
  return { worktreeId, ids }
}

const working = (...ids: string[]): void =>
  useWorkspaceStore.setState((state) => ({
    terminals: Object.fromEntries(
      Object.entries(state.terminals).map(([id, terminal]) => [
        id,
        ids.includes(id) ? { ...terminal, agent: 'claude' as const, busy: true, running: true } : terminal
      ])
    )
  }))

const shown = (worktreeId: string): string[] =>
  collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)

describe('Close Others', () => {
  it('closes every other quiet pane at once and keeps the one pointed at', async () => {
    const { worktreeId, ids } = await panes(3)
    const [a, b, c] = ids as [string, string, string]

    await useWorkspaceStore.getState().closeOtherPanes(b)

    expect(shown(worktreeId)).toEqual([b])
    expect(useWorkspaceStore.getState().terminals[a]).toBeUndefined()
    expect(useWorkspaceStore.getState().terminals[c]).toBeUndefined()
    expect(useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId).toBe(b)
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })

  it('asks about each working pane in turn, and kills nothing it was not told to', async () => {
    const { worktreeId, ids } = await panes(4)
    const [keep, busyOne, quiet, busyTwo] = ids as [string, string, string, string]
    working(busyOne, busyTwo)
    const call = vi.spyOn(runtimeClient, 'call')

    await useWorkspaceStore.getState().closeOtherPanes(keep)
    expect(useWorkspaceStore.getState().dialog).toEqual({
      kind: 'confirm-close-pane',
      terminalId: busyOne,
      rest: [quiet, busyTwo]
    })
    expect(call.mock.calls.filter(([method]) => method === 'terminal.close')).toHaveLength(0)

    // "Leave Open" on the first: the next question comes, the quiet pane closes on the way.
    useWorkspaceStore.getState().closeDialog()
    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-close-pane', terminalId: busyTwo })
    )
    expect(shown(worktreeId)).toEqual([keep, busyOne, busyTwo])

    // "Stop and Close" on the last, as the dialog does it.
    useWorkspaceStore.getState().closeDialog()
    await useWorkspaceStore.getState().forceCloseTerminal(busyTwo)
    expect(useWorkspaceStore.getState().dialog).toBeNull()
    expect(shown(worktreeId)).toEqual([keep, busyOne])
    call.mockRestore()
  })

  it('still asks the one question a single close asks, with nothing queued behind it', async () => {
    const { ids } = await panes(1)
    working(ids[0]!)
    await useWorkspaceStore.getState().closeTerminal(ids[0]!)
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-close-pane', terminalId: ids[0] })
  })
})

describe('Maximize from the menu', () => {
  it('fills the workspace with the pane pointed at, not the focused one, and restores on a second choice', async () => {
    const { worktreeId, ids } = await panes(2)
    const [first, second] = ids as [string, string]
    useWorkspaceStore.getState().focusPane(first)

    useWorkspaceStore.getState().expandPane(second)
    expect(useWorkspaceStore.getState().expandedTerminalId).toBe(second)
    expect(useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId).toBe(second)

    useWorkspaceStore.getState().expandPane(second)
    expect(useWorkspaceStore.getState().expandedTerminalId).toBeNull()
  })

  it('moves the maximised view straight to another pane', async () => {
    const { ids } = await panes(2)
    const [first, second] = ids as [string, string]
    useWorkspaceStore.getState().expandPane(first)
    useWorkspaceStore.getState().expandPane(second)
    expect(useWorkspaceStore.getState().expandedTerminalId).toBe(second)
  })
})

describe('Rename from the menu', () => {
  it('asks the strip to open its name field on that pane', async () => {
    const { ids } = await panes(1)
    useWorkspaceStore.getState().editPaneName(ids[0]!)
    expect(useWorkspaceStore.getState().editingPaneName).toBe(ids[0])
    useWorkspaceStore.getState().editPaneName(null)
    expect(useWorkspaceStore.getState().editingPaneName).toBeNull()
  })
})

describe('Copy Output', () => {
  it('copies what the emulator on screen shows, wrapped rows joined', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { ids } = await panes(1)
    const rows = [
      { isWrapped: false, text: '$ npm test' },
      { isWrapped: false, text: 'a long line that' },
      { isWrapped: true, text: ' wrapped' },
      { isWrapped: false, text: '' }
    ]
    const hide = showPane(ids[0]!, {
      buffer: {
        active: {
          length: rows.length,
          getLine: (row) => ({ isWrapped: rows[row]!.isWrapped, translateToString: () => rows[row]!.text })
        }
      }
    })

    await useWorkspaceStore.getState().copyPaneOutput(ids[0]!, 'zsh')

    expect(writeText).toHaveBeenCalledWith('$ npm test\na long line that wrapped')
    hide()
    vi.unstubAllGlobals()
  })

  it('replays the retained output as plain text for a pane that is not on screen', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { ids } = await panes(1)
    const original = runtimeClient.call.bind(runtimeClient)
    const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
      if (method === 'terminal.read') return { data: '\x1b[31mFAIL\x1b[0m one   \r\n 10%\r100%\r\n' }
      return original(method, params as never)
    })

    await useWorkspaceStore.getState().copyPaneOutput(ids[0]!, 'zsh')

    expect(writeText).toHaveBeenCalledWith('FAIL one\n100%')
    call.mockRestore()
    vi.unstubAllGlobals()
  })
})
