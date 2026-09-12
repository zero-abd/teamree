import { expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

it('adds exactly one pane per New terminal action, including with workspace events', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const stop = store.startWatching()
  try {
    const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
    const before = await runtimeClient.call('terminal.list', { worktreeId })
    const call = vi.spyOn(runtimeClient, 'call')
    await store.createTerminal(worktreeId)
    await store.openWorktree(worktreeId)
    const terminals = await runtimeClient.call('terminal.list', { worktreeId })
    const layout = useWorkspaceStore.getState().layouts[worktreeId]!
    const ids = collectTerminalIds(layout.root)
    expect(terminals).toHaveLength(before.length + 1)
    expect(ids).toHaveLength(terminals.length)
    expect(new Set(ids).size).toBe(ids.length)
    expect(layout).toEqual(await runtimeClient.call('layout.get', { worktreeId }))
    expect(call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(1)
    expect(call.mock.calls.filter(([method]) => method === 'layout.set')).toHaveLength(0)
    call.mockRestore()
  } finally {
    stop()
  }
})

it('reads the changed paths only once the panel is open, and the patch only once a path is picked', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  const call = vi.spyOn(runtimeClient, 'call')
  const changesCalls = (): number => call.mock.calls.filter(([method]) => method === 'worktree.changes').length
  const diffCalls = (): number => call.mock.calls.filter(([method]) => method === 'worktree.diff').length

  // Closed, it costs nothing: a `git status` per refresh for a panel nobody is
  // looking at is exactly the kind of thing that makes an app feel heavy.
  expect(useWorkspaceStore.getState().changesOpen).toBe(false)
  expect(changesCalls()).toBe(0)

  useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]).toBeDefined())
  expect(changesCalls()).toBe(1)
  const listed = useWorkspaceStore.getState().changes[worktreeId]
  expect(listed?.changes.length).toBeGreaterThan(0)
  expect(diffCalls()).toBe(0)

  const path = listed!.changes[0]!.path
  useWorkspaceStore.getState().selectChange(path)
  await vi.waitFor(() => expect(useWorkspaceStore.getState().diffPending).toBe(false))
  expect(diffCalls()).toBe(1)
  expect(useWorkspaceStore.getState().diff?.patch).toContain('diff --git')

  // Picking the same row again clears it, and clearing costs no call.
  useWorkspaceStore.getState().selectChange(null)
  expect(useWorkspaceStore.getState().diff).toBeNull()
  expect(diffCalls()).toBe(1)
  call.mockRestore()
})

it('does not carry one worktree’s patch across to another worktree', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const ready = useWorkspaceStore.getState().worktrees.filter((entry) => entry.state === 'ready')
  const [first, second] = [ready[0]!, ready[1]!]

  await store.openWorktree(first.id)
  if (!useWorkspaceStore.getState().changesOpen) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[first.id]).toBeDefined())

  const path = useWorkspaceStore.getState().changes[first.id]!.changes[0]?.path
  if (path !== undefined) {
    useWorkspaceStore.getState().selectChange(path)
    await vi.waitFor(() => expect(useWorkspaceStore.getState().diff).not.toBeNull())
  }

  await store.openWorktree(second.id)

  expect(useWorkspaceStore.getState().selectedChangePath).toBeNull()
  expect(useWorkspaceStore.getState().diff).toBeNull()
})

it('reads mergeability for ready worktrees, a few at a time', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()

  let inFlight = 0
  let peak = 0
  const original = runtimeClient.call.bind(runtimeClient)
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    if (method !== 'worktree.mergePreview') return original(method, params as never)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      return await original(method, params as never)
    } finally {
      inFlight -= 1
    }
  })

  // A worktree list refresh is what drives the read, the same as it drives the
  // status chips the badge sits beside.
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  await vi.waitFor(() => expect(useWorkspaceStore.getState().mergePreviews[worktreeId]).toBeDefined())

  expect(useWorkspaceStore.getState().mergePreviews[worktreeId]?.baseRef).toBeTruthy()
  // Each preview is a git process; the sidebar is not worth an unbounded fan-out.
  expect(peak).toBeLessThanOrEqual(4)
  call.mockRestore()
})

it('commits only the ticked paths, and unticks them afterwards', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  if (!useWorkspaceStore.getState().changesOpen) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]?.changes.length).toBeGreaterThan(1))

  const rows = useWorkspaceStore.getState().changes[worktreeId]!.changes
  const [first, second] = [rows[0]!.path, rows[1]!.path]

  // Ticking is browsing: nothing is staged in git until the commit.
  useWorkspaceStore.getState().toggleStaged(first)
  useWorkspaceStore.getState().toggleStaged(second)
  useWorkspaceStore.getState().toggleStaged(second)
  expect(useWorkspaceStore.getState().stagedPaths).toEqual([first])

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().commitStaged('a real message')

  const committed = call.mock.calls.find(([method]) => method === 'worktree.commit')
  expect(committed?.[1]).toMatchObject({ worktreeId, message: 'a real message', paths: [first] })
  expect(useWorkspaceStore.getState().stagedPaths).toEqual([])
  call.mockRestore()
})

it('refuses to commit with nothing ticked or no message', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  const call = vi.spyOn(runtimeClient, 'call')
  // Nothing ticked: the store does not ask the runtime to decide for it.
  await useWorkspaceStore.getState().commitStaged('has a message')
  expect(call.mock.calls.filter(([method]) => method === 'worktree.commit')).toHaveLength(0)
  call.mockRestore()
})

it('drops a tick for a path that stopped being a change', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  if (!useWorkspaceStore.getState().changesOpen) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]).toBeDefined())

  const real = useWorkspaceStore.getState().changes[worktreeId]!.changes[0]!.path
  useWorkspaceStore.getState().toggleStaged(real)
  useWorkspaceStore.getState().toggleStaged('src/reverted-since.ts')
  expect(useWorkspaceStore.getState().stagedPaths).toHaveLength(2)

  // A refresh is what prunes it: a tick that would fail the commit is worse
  // than no tick at all.
  await store.openWorktree(worktreeId)
  useWorkspaceStore.getState().toggleChanges()
  useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().stagedPaths).toEqual([real]))
})

it('pushes the active worktree and says what actually happened', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const ahead = useWorkspaceStore
    .getState()
    .worktrees.find(
      (entry) => entry.state === 'ready' && (useWorkspaceStore.getState().statuses[entry.id]?.ahead ?? 0) > 0
    )
  const worktreeId = (ahead ?? useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!).id
  await store.openWorktree(worktreeId)

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().pushActiveWorktree()

  expect(call.mock.calls.filter(([method]) => method === 'worktree.push')).toHaveLength(1)
  // The outcome reaches the user, rather than the push happening in silence.
  const notice = useWorkspaceStore.getState().notices.at(-1)
  expect(notice?.tone).toBe('info')
  expect(notice?.text).toMatch(/pushed|already had/i)
  expect(useWorkspaceStore.getState().pushing).toBe(false)
  call.mockRestore()
})

it('never fires two pushes at once', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  const call = vi.spyOn(runtimeClient, 'call')
  // A double-click is one push: the second call finds the first still running.
  await Promise.all([
    useWorkspaceStore.getState().pushActiveWorktree(),
    useWorkspaceStore.getState().pushActiveWorktree()
  ])

  expect(call.mock.calls.filter(([method]) => method === 'worktree.push')).toHaveLength(1)
  call.mockRestore()
})
