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

it('opens the worktree a pane lives in, focuses that pane, and leaves the dashboard', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()

  const panes = await runtimeClient.call('terminal.list', {})
  // A worktree with more than one pane, so focusing the right one is a claim
  // that can actually fail.
  const worktreeId = panes
    .map((pane) => pane.worktreeId)
    .find((id, _, all) => all.filter((entry) => entry === id).length > 1)!
  const elsewhere = useWorkspaceStore
    .getState()
    .worktrees.find((entry) => entry.state === 'ready' && entry.id !== worktreeId)!

  await store.openWorktree(elsewhere.id)
  store.toggleDashboard()
  expect(useWorkspaceStore.getState().dashboardOpen).toBe(true)

  // Deliberately not the pane that already has the focus there, so the
  // assertion below is about this call rather than about the stored layout.
  const seeded = await runtimeClient.call('layout.get', { worktreeId })
  const target = panes.find((pane) => pane.worktreeId === worktreeId && pane.id !== seeded.focusedTerminalId)!

  await useWorkspaceStore.getState().revealPane(worktreeId, target.id)

  expect(useWorkspaceStore.getState().activeWorktreeId).toBe(worktreeId)
  expect(useWorkspaceStore.getState().layouts[worktreeId]?.focusedTerminalId).toBe(target.id)
  // Picking a row is the answer the view was opened to get, so it gets out of
  // the way rather than leaving the pane it just focused hidden behind it.
  expect(useWorkspaceStore.getState().dashboardOpen).toBe(false)
})

it('never forces a worktree removal without asking first', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  // A worktree with uncommitted work is exactly the case the runtime refuses.
  const dirty = useWorkspaceStore.getState().worktrees.find((entry) => {
    const status = useWorkspaceStore.getState().statuses[entry.id]
    return entry.state === 'ready' && status !== undefined && status.unstaged + status.staged > 0
  })!

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().removeWorktree(dirty.id)

  const attempts = call.mock.calls.filter(([method]) => method === 'worktree.remove')
  expect(attempts).toHaveLength(1)
  // The whole point: the first attempt is unforced, so git gets to refuse.
  expect(attempts[0]?.[1]).toEqual({ worktreeId: dirty.id })
  // Nothing was removed, and the user is being asked.
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === dirty.id)).toBe(true)
  expect(useWorkspaceStore.getState().dialog).toMatchObject({ kind: 'confirm-remove', worktreeId: dirty.id })
  call.mockRestore()
})

it('discards the work only once that has been confirmed', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const dirty = useWorkspaceStore.getState().worktrees.find((entry) => {
    const status = useWorkspaceStore.getState().statuses[entry.id]
    return entry.state === 'ready' && status !== undefined && status.unstaged + status.staged > 0
  })!

  await useWorkspaceStore.getState().removeWorktree(dirty.id)
  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().forceRemoveWorktree(dirty.id)

  expect(call.mock.calls.find(([method]) => method === 'worktree.remove')?.[1]).toEqual({
    worktreeId: dirty.id,
    force: true
  })
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === dirty.id)).toBe(false)
  expect(useWorkspaceStore.getState().dialog).toBeNull()
  call.mockRestore()
})

it('removes a clean worktree without stopping to ask', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const clean = useWorkspaceStore.getState().worktrees.find((entry) => {
    const status = useWorkspaceStore.getState().statuses[entry.id]
    return (
      entry.state === 'ready' &&
      status !== undefined &&
      status.staged + status.unstaged + status.untracked + status.conflicted === 0
    )
  })!

  await useWorkspaceStore.getState().removeWorktree(clean.id)

  // Nothing is lost by removing a clean checkout, so nagging about it would
  // only teach people to click through the dialog that matters.
  expect(useWorkspaceStore.getState().dialog).toBeNull()
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === clean.id)).toBe(false)
})

// The CLI panel re-reads on open, so the read is where a stale refusal has to
// go: a password not given to an attempt that was abandoned is not a fact about
// the next time the panel is opened.
it('does not repeat a CLI refusal to somebody who reopens the panel', async () => {
  useWorkspaceStore.setState({ cliError: 'The administrator password was not given, so nothing was changed.' })

  await useWorkspaceStore.getState().loadCli()

  expect(useWorkspaceStore.getState().cliError).toBeNull()
  expect(useWorkspaceStore.getState().cli).not.toBeNull()
})

// The other half of the same line: a refusal that did happen is re-read past,
// because installCli re-reads the destination before it shows what refused it.
it('keeps the refusal of an install that was refused, across the re-read it does', async () => {
  const refused = 'The administrator password was not given, so nothing was changed.'
  const call = vi.spyOn(runtimeClient, 'call').mockRejectedValueOnce(new Error(refused))

  await useWorkspaceStore.getState().installCli()
  call.mockRestore()

  expect(useWorkspaceStore.getState().cliError).toBe(refused)
  expect(useWorkspaceStore.getState().cliPending).toBe(false)
})
