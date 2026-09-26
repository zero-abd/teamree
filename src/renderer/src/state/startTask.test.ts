// The composer's whole promise, through the in-memory runtime: one submission creates the
// worktrees, waits for them, and leaves each agent running in its own.

import { expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { taskCreates } from '../dialogs/taskPlan'
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

    store.startTask({
      projectId,
      startedFrom: 'origin/main',
      creates: [{ name: 'Rewrite the pager', agentCommand: agent.command, task: 'Rewrite the pager so it streams' }]
    })

    // The dialog is gone before any of the work is: the sidebar row narrates it.
    expect(useWorkspaceStore.getState().dialog).toBeNull()

    const created = await until(
      () => useWorkspaceStore.getState().worktrees.some((worktree) => worktree.name === 'Rewrite the pager'),
      'the worktree to be created'
    ).then(() => useWorkspaceStore.getState().worktrees.find((worktree) => worktree.name === 'Rewrite the pager')!)

    // Every pane the runtime opened is in the layout: the tab opened before any of them existed.
    await until(() => {
      const state = useWorkspaceStore.getState()
      const panes = collectTerminalIds(state.layouts[created.id]?.root ?? null)
      const known = Object.values(state.terminals).filter((one) => one.worktreeId === created.id)
      return (
        state.activeWorktreeId === created.id &&
        state.worktrees.find((one) => one.id === created.id)?.state === 'ready' &&
        known.some((one) => one.title === agent.command) &&
        known.every((one) => panes.includes(one.id))
      )
    }, 'the new worktree to open with its panes')

    const state = useWorkspaceStore.getState()
    expect(state.worktrees.find((worktree) => worktree.id === created.id)?.state).toBe('ready')
    expect(state.openWorktreeIds).toContain(created.id)

    // Nothing was started before the checkout was ready: a terminal.create ahead of that has nowhere to run.
    const agentPanes = call.mock.calls.filter(([method]) => method === 'terminal.create')
    expect(agentPanes).toHaveLength(1)
    // The pane is named after what was typed, and the description travels as its first prompt and
    // as the checkout's record.
    expect(agentPanes[0]![1]).toEqual({
      worktreeId: created.id,
      command: agent.command,
      label: 'Rewrite the pager',
      prompt: 'Rewrite the pager so it streams'
    })
    const creates = call.mock.calls.filter(([method]) => method === 'worktree.create')
    expect(creates[0]![1]).toEqual(
      expect.objectContaining({ name: 'Rewrite the pager', task: 'Rewrite the pager so it streams' })
    )
    expect(state.worktrees.find((worktree) => worktree.id === created.id)?.task).toBe('Rewrite the pager so it streams')

    const layout = state.layouts[created.id]!
    const terminals = await runtimeClient.call('terminal.list', { worktreeId: created.id })
    expect(collectTerminalIds(layout.root)).toEqual(expect.arrayContaining(terminals.map((one) => one.id)))
    expect(terminals.some((one) => one.title === agent.command)).toBe(true)
    expect(terminals.map((one) => one.label)).toContain('Rewrite the pager')

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

    // The seeded runtime fails any task whose name says so.
    store.startTask({
      projectId,
      creates: [{ name: 'fail on purpose', agentCommand: 'claude', task: 'fail on purpose' }]
    })

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

it('asks for the branch the composer was given', { timeout: 20_000 }, async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const call = vi.spyOn(runtimeClient, 'call')
  try {
    const projectId = useWorkspaceStore.getState().projects[0]!.id
    store.startTask({ projectId, creates: [{ name: 'Named by hand', task: 'Named by hand', branch: 'ada/by-hand' }] })
    await until(
      () => useWorkspaceStore.getState().worktrees.some((one) => one.name === 'Named by hand'),
      'the worktree to be created'
    )
    const create = call.mock.calls.find(([method]) => method === 'worktree.create')
    expect(create?.[1]).toEqual(expect.objectContaining({ name: 'Named by hand', branch: 'ada/by-hand' }))
  } finally {
    call.mockRestore()
  }
})

// One description, several attempts at it, each in its own checkout with its own agent.
it('creates one worktree per selected agent, each running its own', { timeout: 30_000 }, async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const projectId = useWorkspaceStore.getState().projects[0]!.id
    const agents = await runtimeClient.call('agent.list', {})
    const claude = agents[0]!
    const codex = agents[1]!
    const call = vi.spyOn(runtimeClient, 'call')

    store.startTask({
      projectId,
      startedFrom: 'origin/main',
      creates: taskCreates('Race the pager', [claude, codex, claude])
    })

    const names = ['Race the pager claude', 'Race the pager codex', 'Race the pager claude 2']
    await until(
      () => names.every((name) => useWorkspaceStore.getState().worktrees.some((one) => one.name === name)),
      'all three worktrees to be created'
    )

    const made = names.map((name) => useWorkspaceStore.getState().worktrees.find((one) => one.name === name)!)
    // Three branches, not one branch and two failures: the suffix keeps them apart.
    expect(new Set(made.map((one) => one.branch)).size).toBe(3)

    await until(
      () =>
        made.every((one) =>
          call.mock.calls.some(
            ([method, params]) =>
              method === 'terminal.create' && (params as { worktreeId: string }).worktreeId === one.id
          )
        ),
      'each worktree to get its agent'
    )

    const panes = call.mock.calls
      .filter(([method]) => method === 'terminal.create')
      .map(([, params]) => params as { worktreeId: string; command: string })
    expect(panes).toHaveLength(3)
    expect(panes.map((pane) => pane.command)).toEqual([claude.command, codex.command, claude.command])
    expect(panes.map((pane) => pane.worktreeId)).toEqual(made.map((one) => one.id))

    call.mockRestore()
  } finally {
    stop()
  }
})

// Starting the task is the click that opens the tab; a checkout finishing tens of seconds later
// must not change tabs under whoever went on typing somewhere else.
it(
  'opens the tab as the composer closes, and never moves you again once the checkout is ready',
  { timeout: 20_000 },
  async () => {
    const store = useWorkspaceStore.getState()
    await store.bootstrap()
    const stop = store.startWatching()
    try {
      const projectId = useWorkspaceStore.getState().projects[0]!.id
      const elsewhere = useWorkspaceStore.getState().worktrees.find((worktree) => worktree.state === 'ready')!
      const agent = (await runtimeClient.call('agent.list', {}))[0]!
      const call = vi.spyOn(runtimeClient, 'call')

      store.startTask({
        projectId,
        creates: [{ name: 'Stream the pager', agentCommand: agent.command, task: 'Stream the pager' }]
      })

      const created = await until(
        () => useWorkspaceStore.getState().worktrees.some((worktree) => worktree.name === 'Stream the pager'),
        'the worktree to be created'
      ).then(() => useWorkspaceStore.getState().worktrees.find((worktree) => worktree.name === 'Stream the pager')!)

      // In front at once, while the checkout is still being made.
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe(created.id)
      expect(useWorkspaceStore.getState().worktrees.find((one) => one.id === created.id)?.state).toBe('creating')

      // Going somewhere else to type while it is made.
      await store.openWorktree(elsewhere.id)
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe(elsewhere.id)

      await until(
        () =>
          call.mock.calls.some(
            ([method, params]) =>
              method === 'terminal.create' && (params as { worktreeId: string }).worktreeId === created.id
          ),
        'the agent to be started'
      )
      await until(
        () => collectTerminalIds(useWorkspaceStore.getState().layouts[created.id]?.root ?? null).length > 0,
        'the agent’s pane to land in the layout'
      )

      expect(useWorkspaceStore.getState().activeWorktreeId).toBe(elsewhere.id)

      call.mockRestore()
    } finally {
      stop()
    }
  }
)

// The mode's flags go on the command itself; what Settings always passes stays in `agentArgs`, after them.
it('launches the agent in the permission mode the composer chose', { timeout: 20_000 }, async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  const call = vi.spyOn(runtimeClient, 'call')
  try {
    const projectId = useWorkspaceStore.getState().projects[0]!.id
    const claude = (await runtimeClient.call('agent.list', {})).find((agent) => agent.kind === 'claude')!
    useWorkspaceStore.setState({ agentArgs: { claude: '--model opus' } })

    store.startTask({ projectId, creates: taskCreates('Skip the prompts', [claude], '', { claude: 'bypass' }) })

    await until(() => call.mock.calls.some(([method]) => method === 'terminal.create'), 'the agent to be started')
    const pane = call.mock.calls.find(([method]) => method === 'terminal.create')![1]
    expect(pane).toEqual(
      expect.objectContaining({
        command: `${claude.command} --dangerously-skip-permissions`,
        agentArgs: '--model opus'
      })
    )
  } finally {
    call.mockRestore()
    useWorkspaceStore.setState({ agentArgs: {} })
    stop()
  }
})
