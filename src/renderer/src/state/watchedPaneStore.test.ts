// A teammate's pane as the window holds it: opened from a sidebar row, focused
// and closed by the same paths as your own panes, and never once written into a
// layout the runtime owns.
//
// That last one is the load-bearing part. The runtime reconciles every stored
// layout against the sessions it actually has, so a leaf naming a pane on
// somebody else's laptop would be pruned at the next launch — and before that,
// a `layout.set` carrying one would be this window telling the runtime it has a
// terminal it has never heard of. So the focus for a watched pane lives here,
// beside the panes themselves, and the assertions below are as much about what
// is *not* sent as about what is.

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

  // The floating card could only ever be one because it was one card. Several
  // teammates side by side is the thing a pane in the workspace can do and it
  // could not.
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

  // A chunk that was in flight when the pane closed would otherwise leave a
  // tail behind for a pane nobody can see, quoted on a row that is not live.
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

  // The tree the new pane would go in is on their machine, and this window has
  // no say in it.
  it('does not split a teammate’s pane', async () => {
    await openAWorktree()
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    const call = vi.spyOn(runtimeClient, 'call')
    await store().splitFocusedPane('row')
    expect(call.mock.calls.filter(([method]) => method === 'terminal.split')).toHaveLength(0)
    call.mockRestore()
  })

  // Find searches an emulator's scrollback, and a watched pane's is a picture
  // of somebody else's screen with no search addon on it. Opening the field
  // over a pane that is not the focused one would be worse than not opening it.
  it('does not open the find bar over a teammate’s pane', async () => {
    await openAWorktree()
    store().toggleWatchedPane('p1', theirs('priya:t7'))
    store().openPaneSearch()
    expect(store().paneSearch).toBeNull()
  })
})
