// A teammate's pane as the window holds it, never written into a layout the
// runtime owns: the runtime prunes stored layouts against the sessions it has,
// and a `layout.set` naming somebody else's pane would name a terminal it has never heard of.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { collectTerminalIds } from '../panes/paneLayout'
import { watchedPaneId } from '../panes/watchedPanes'
import { useWorkspaceStore } from './workspaceStore'

const theirs = (paneId: string, label = 'claude') => ({ terminalId: paneId, label, handle: paneId.split(':')[0]! })

const store = (): ReturnType<typeof useWorkspaceStore.getState> => useWorkspaceStore.getState()

/** A window with one ready worktree open, which is where a watcher watches from. */
async function openAWorktree(): Promise<string> {
  await store().bootstrap()
  const worktreeId = store().worktrees.find((worktree) => worktree.state === 'ready')!.id
  await store().openWorktree(worktreeId)
  return worktreeId
}

beforeEach(() => {
  useWorkspaceStore.setState({ watches: [], watchTails: {}, watchSizes: [], focusedWatchId: null })
})

describe('opening and closing one', () => {
  it('opens the pane that was asked for, and focuses it the way a new pane is focused', () => {
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    expect(store().watches).toEqual([
      { id: watchedPaneId('p1', 'priya:t7'), projectId: 'p1', paneId: 'priya:t7', label: 'claude', handle: 'priya' }
    ])
    expect(store().focusedWatchId).toBe(watchedPaneId('p1', 'priya:t7'))
  })

  it('opens a second beside the first, in the order they were asked for', () => {
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    store().toggleWatchedPane('p1', theirs('ana:t2'))
    expect(store().watches.map((watch) => watch.paneId)).toEqual(['priya:t7', 'ana:t2'])
  })

  it('closes the one already open when the same pane is asked for again', () => {
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    expect(store().watches).toEqual([])
    expect(store().focusedWatchId).toBeNull()
  })

  it('hands the focus to the pane that takes its place, and back to your own tree when there is none', () => {
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    store().toggleWatchedPane('p1', theirs('ana:t2'))
    store().focusPane(watchedPaneId('p1', 'priya:t7'))
    store().closeWatchedPane(watchedPaneId('p1', 'priya:t7'))
    expect(store().focusedWatchId).toBe(watchedPaneId('p1', 'ana:t2'))
    store().closeWatchedPane(watchedPaneId('p1', 'ana:t2'))
    expect(store().focusedWatchId).toBeNull()
  })

  it('refuses to focus a pane this window does not have open', () => {
    store().focusPane(watchedPaneId('p1', 'nobody:t1'))
    expect(store().focusedWatchId).toBeNull()
  })
})

describe('what a watched pane has printed', () => {
  it('keeps the tail, so a sidebar row can quote its last line', () => {
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    const id = watchedPaneId('p1', 'priya:t7')
    store().noteWatchedPaneOutput(id, 'running ')
    store().noteWatchedPaneOutput(id, 'tests')
    expect(store().watchTails[id]).toBe('running tests')
  })

  // A chunk in flight when the pane closed would leave a tail quoted on a row that is not live.
  it('drops what arrives after the pane has gone, rather than keeping a tail for it', () => {
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    const id = watchedPaneId('p1', 'priya:t7')
    store().closeWatchedPane(id)
    store().noteWatchedPaneOutput(id, 'one last line')
    expect(store().watchTails).toEqual({})
  })
})

describe('the same keyboard as every other pane', () => {
  it('walks your own panes and then the teammates’, and wraps', async () => {
    const worktreeId = await openAWorktree()
    const locals = collectTerminalIds(store().layouts[worktreeId]?.root ?? null)
    expect(locals.length).toBeGreaterThan(0)

    store().toggleWatchedPane('p1', theirs('priya:t7'))
    store().focusPane(locals[locals.length - 1]!)
    expect(store().focusedWatchId).toBeNull()

    store().focusNextPane()
    expect(store().focusedWatchId).toBe(watchedPaneId('p1', 'priya:t7'))

    // And round again, back onto this machine's own first pane.
    store().focusNextPane()
    expect(store().focusedWatchId).toBeNull()
    expect(store().layouts[worktreeId]?.focusedTerminalId).toBe(locals[0])
  })

  it('never writes a teammate’s pane into a layout the runtime owns', async () => {
    const worktreeId = await openAWorktree()
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    const call = vi.spyOn(runtimeClient, 'call')
    store().focusPane(watchedPaneId('p1', 'priya:t7'))
    store().focusNextPane()
    expect(call.mock.calls.filter(([method]) => method === 'layout.set')).not.toContainEqual(
      expect.arrayContaining([expect.objectContaining({ focusedTerminalId: watchedPaneId('p1', 'priya:t7') })])
    )
    expect(collectTerminalIds(store().layouts[worktreeId]?.root ?? null)).not.toContain(watchedPaneId('p1', 'priya:t7'))
    call.mockRestore()
  })

  // The tree the new pane would go in is on their machine.
  it('does not split a teammate’s pane', async () => {
    await openAWorktree()
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    const call = vi.spyOn(runtimeClient, 'call')
    await store().splitFocusedPane('row')
    expect(call.mock.calls.filter(([method]) => method === 'terminal.split')).toHaveLength(0)
    call.mockRestore()
  })

  // A watched pane's scrollback is a picture of somebody else's screen with no
  // search addon; opening the field over an unfocused pane is worse than not opening it.
  it('does not open the find bar over a teammate’s pane', async () => {
    await openAWorktree()
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    store().openPaneSearch()
    expect(store().paneSearch).toBeNull()
  })
})
