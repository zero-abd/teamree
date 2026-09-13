// The composer's whole promise, through the in-memory runtime: one submission
// creates the worktree, waits for it, and leaves the agent running in it.

import { expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

/** Resolves once `ready` holds, driven by the store rather than by a sleep. */
function until(ready: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  if (ready()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for ${what}.`))
    }, timeoutMs)
    const unsubscribe = useWorkspaceStore.subscribe(() => {
      if (!ready()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

it('creates the worktree, then runs the chosen agent in it', { timeout: 20_000 }, async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const projectId = useWorkspaceStore.getState().projects[0]!.id
    const agent = (await runtimeClient.call('agent.list', {}))[0]!
    const call = vi.spyOn(runtimeClient, 'call')

    store.startTask({ projectId, task: 'Rewrite the pager', startedFrom: 'origin/main', agentCommand: agent.command })

    // The dialog is gone before any of the work is: the sidebar row narrates it.
    expect(useWorkspaceStore.getState().dialog).toBeNull()

    const created = await until(
      () => useWorkspaceStore.getState().worktrees.some((worktree) => worktree.name === 'Rewrite the pager'),
      'the worktree to be created'
    ).then(() => useWorkspaceStore.getState().worktrees.find((worktree) => worktree.name === 'Rewrite the pager')!)

    await until(
      () =>
        useWorkspaceStore.getState().activeWorktreeId === created.id &&
        created.id in useWorkspaceStore.getState().layouts,
      'the new worktree to open with its panes'
    )

    const state = useWorkspaceStore.getState()
    expect(state.worktrees.find((worktree) => worktree.id === created.id)?.state).toBe('ready')
    expect(state.openWorktreeIds).toContain(created.id)

    // The pane the agent runs in exists, and nothing was started before the
    // checkout was ready: a terminal.create ahead of that would have had
    // nowhere to run.
    const agentPanes = call.mock.calls.filter(([method]) => method === 'terminal.create')
    expect(agentPanes).toHaveLength(1)
    expect(agentPanes[0]![1]).toEqual({ worktreeId: created.id, command: agent.command })

    const layout = state.layouts[created.id]!
    const terminals = await runtimeClient.call('terminal.list', { worktreeId: created.id })
    expect(collectTerminalIds(layout.root)).toEqual(expect.arrayContaining(terminals.map((one) => one.id)))
    expect(terminals.some((one) => one.title === agent.command)).toBe(true)

    call.mockRestore()
  } finally {
    stop()
  }
})

it('reports why a task that could not be created failed, and starts no agent', { timeout: 20_000 }, async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const projectId = useWorkspaceStore.getState().projects[0]!.id
    const call = vi.spyOn(runtimeClient, 'call')

    // The seeded runtime fails any task whose name says so, which is the only
    // way to reach this path without a real repository to break.
    store.startTask({ projectId, task: 'fail on purpose', agentCommand: 'claude' })

    await until(() => useWorkspaceStore.getState().notices.length > 0, 'the failure to be reported')

    const notice = useWorkspaceStore.getState().notices.at(-1)!
    expect(notice.tone).toBe('error')
    expect(notice.text).toContain('Could not start the task')
    expect(call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(0)

    call.mockRestore()
  } finally {
    stop()
  }
})
