import { describe, expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'
import { fileLeavesIn } from '@shared/filePane'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { changesOnScreen } from '../workspace/rightPanel/rightPanelState'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import {
  reconcileRelayPanes,
  teamworkPaneFromWorktreeId,
  teamworkPaneWorktreeId,
  useWorkspaceStore,
  type RelayPaneState
} from './workspaceStore'
import type { RelaySetting, Terminal, WorktreePush } from '@shared/entities'
import { harnessName } from '../agents/harnesses'
import { NOTICE_LIFETIME_MS } from '../notices/noticeLifetime'

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

it('reads the changed paths only once the panel is open, and opens a picked path as a diff in the centre', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  const call = vi.spyOn(runtimeClient, 'call')
  const changesCalls = (base = false): number =>
    call.mock.calls.filter(
      ([method, params]) => method === 'worktree.changes' && ((params as { base?: boolean }).base === true) === base
    ).length
  const diffCalls = (): number => call.mock.calls.filter(([method]) => method === 'worktree.diff').length

  // Closed, it costs nothing: no `git status` per refresh for a panel nobody is looking at.
  expect(changesOnScreen(useWorkspaceStore.getState())).toBe(false)
  expect(changesCalls()).toBe(0)

  useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]).toBeDefined())
  expect(changesCalls()).toBe(1)
  expect(changesCalls(true)).toBe(1)
  const listed = useWorkspaceStore.getState().changes[worktreeId]
  expect(listed?.changes.length).toBeGreaterThan(0)

  const path = listed!.changes[0]!.path
  const fileLeaves = () => fileLeavesIn(useWorkspaceStore.getState().layouts[worktreeId]!.root)
  useWorkspaceStore.getState().selectChange(path)
  expect(useWorkspaceStore.getState().selectedChangePath).toBe(path)
  const [pane] = fileLeaves().filter((leaf) => leaf.path === path)
  expect(pane).toBeDefined()
  expect(useWorkspaceStore.getState().layouts[worktreeId]!.focusedTerminalId).toBe(pane!.terminalId)
  expect(useWorkspaceStore.getState().diffPanes[pane!.terminalId]).toBe(true)
  // The pane reads its own diff; the panel reads none.
  expect(diffCalls()).toBe(0)

  // Back to the text, then the row again: the same pane, in Diff mode again.
  useWorkspaceStore.getState().setPaneDiff(pane!.terminalId, false)
  useWorkspaceStore.getState().selectChange(path)
  expect(fileLeaves().filter((leaf) => leaf.path === path)).toHaveLength(1)
  expect(useWorkspaceStore.getState().diffPanes[pane!.terminalId]).toBe(true)
  call.mockRestore()
})

it('does not carry one worktree’s selected change across to another worktree', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const ready = useWorkspaceStore.getState().worktrees.filter((entry) => entry.state === 'ready')
  const [first, second] = [ready[0]!, ready[1]!]

  await store.openWorktree(first.id)
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[first.id]).toBeDefined())

  const path = useWorkspaceStore.getState().changes[first.id]!.changes[0]?.path
  if (path !== undefined) useWorkspaceStore.getState().selectChange(path)

  await store.openWorktree(second.id)

  expect(useWorkspaceStore.getState().selectedChangePath).toBeNull()
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

  // A worktree list refresh drives the read, as it drives the status chips beside the badge.
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
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
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

// The commit lands in the list the button is under; a toast would say it twice.
it('toasts a commit only when the Changes tab is not showing it', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]?.changes.length).toBeGreaterThan(0))
  const listed = useWorkspaceStore.getState().changes[worktreeId]!
  const committedNotices = (): string[] =>
    useWorkspaceStore
      .getState()
      .notices.map((notice) => notice.text)
      .filter((text) => text.startsWith('Committed'))

  useWorkspaceStore.setState({ notices: [] })
  expect(await useWorkspaceStore.getState().commitStaged('on screen')).toBe(true)
  expect(committedNotices()).toEqual([])

  useWorkspaceStore.getState().toggleChanges()
  expect(changesOnScreen(useWorkspaceStore.getState())).toBe(false)
  useWorkspaceStore.setState((state) => ({ changes: { ...state.changes, [worktreeId]: listed } }))
  expect(await useWorkspaceStore.getState().commitStaged('off screen')).toBe(true)
  expect(committedNotices()).toHaveLength(1)
})

it('commits every listed change when nothing is ticked, and nothing when there is none', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]).toBeDefined())
  const listed = useWorkspaceStore.getState().changes[worktreeId]!.changes.map((change) => change.path)
  expect(listed.length).toBeGreaterThan(0)

  const call = vi.spyOn(runtimeClient, 'call')
  expect(await useWorkspaceStore.getState().commitStaged('has a message')).toBe(true)
  expect(call.mock.calls.find(([method]) => method === 'worktree.commit')?.[1]).toMatchObject({ paths: listed })

  call.mockClear()
  useWorkspaceStore.setState((state) => ({
    changes: { ...state.changes, [worktreeId]: { ...state.changes[worktreeId]!, changes: [] } }
  }))
  expect(await useWorkspaceStore.getState().commitStaged('has a message')).toBe(false)
  expect(call.mock.calls.filter(([method]) => method === 'worktree.commit')).toHaveLength(0)
  call.mockRestore()
})

it('drops a tick for a path that stopped being a change', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
  await vi.waitFor(() => expect(useWorkspaceStore.getState().changes[worktreeId]).toBeDefined())

  const real = useWorkspaceStore.getState().changes[worktreeId]!.changes[0]!.path
  useWorkspaceStore.getState().toggleStaged(real)
  useWorkspaceStore.getState().toggleStaged('src/reverted-since.ts')
  expect(useWorkspaceStore.getState().stagedPaths).toHaveLength(2)

  // A refresh prunes it: a tick that would fail the commit is worse than none.
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

  // Pushed from the menu with the Changes tab out of sight, where only a notice says so.
  useWorkspaceStore.setState({ rightPanelOpen: false })
  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().pushActiveWorktree()

  expect(call.mock.calls.filter(([method]) => method === 'worktree.push')).toHaveLength(1)
  // The outcome reaches the user, rather than the push happening in silence.
  const notice = useWorkspaceStore.getState().notices.at(-1)
  expect(notice?.tone).toBe('info')
  expect(notice?.text).toMatch(/^(Pushed|Up to date)$/)
  expect(useWorkspaceStore.getState().pushing).toBe(false)
  call.mockRestore()
})

// An informational notice with nothing to do about it leaves on its own.
// Errors stay, and so does anything with a button.
describe('how long a notice stays', () => {
  it('retires plain news after a while, and keeps errors and offers', async () => {
    vi.useFakeTimers()
    // The seeded runtime answers after a short sleep, which fake timers would
    // hold forever: each call is awaited with the clock moving under it.
    const settle = async <T>(work: Promise<T>): Promise<T> => {
      await vi.advanceTimersByTimeAsync(500)
      return work
    }
    try {
      const store = useWorkspaceStore.getState()
      await settle(store.bootstrap())
      const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
      await settle(store.openWorktree(worktreeId))
      useWorkspaceStore.setState({ rightPanelOpen: false })

      const url = 'https://github.com/o/r/compare/main...work?expand=1'
      const original = runtimeClient.call.bind(runtimeClient)
      let reviewUrl: string | undefined
      const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
        if (method === 'worktree.remove') throw new Error('refused')
        const result = await original(method, params as never)
        return method === 'worktree.push' && reviewUrl !== undefined
          ? { ...(result as WorktreePush), reviewUrl }
          : result
      })

      await settle(useWorkspaceStore.getState().pushActiveWorktree())
      const news = useWorkspaceStore.getState().notices.at(-1)!
      expect(news.tone).toBe('info')
      expect(news.action).toBeUndefined()

      reviewUrl = url
      await settle(useWorkspaceStore.getState().pushActiveWorktree())
      const offer = useWorkspaceStore.getState().notices.at(-1)!
      expect(offer.action).toBeDefined()

      await settle(useWorkspaceStore.getState().confirmRemoveWorktree(worktreeId, false))
      const failure = useWorkspaceStore.getState().notices.at(-1)!
      expect(failure.tone).toBe('error')

      const ids = (): number[] => useWorkspaceStore.getState().notices.map((notice) => notice.id)
      expect(ids()).toEqual([news.id, offer.id, failure.id])
      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS)
      expect(ids()).toEqual([offer.id, failure.id])
      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS * 10)
      expect(ids()).toEqual([offer.id, failure.id])
      call.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Only the push result knows a review became possible, so only its notice can offer to open one.
it('offers the review page the push came back with', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  const url = 'https://github.com/o/r/compare/main...work?expand=1'
  const original = runtimeClient.call.bind(runtimeClient)
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    const result = await original(method, params as never)
    return method === 'worktree.push' ? { ...(result as WorktreePush), reviewUrl: url } : result
  })
  useWorkspaceStore.setState({ rightPanelOpen: false })

  await useWorkspaceStore.getState().pushActiveWorktree()

  expect(useWorkspaceStore.getState().notices.at(-1)?.action).toEqual({ label: 'Open review', url })
  call.mockRestore()
})

// A remote that is not a forge teamree can name is an ordinary push.
it('offers nothing to open when the push named no review page', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  await useWorkspaceStore.getState().pushActiveWorktree()

  expect(useWorkspaceStore.getState().notices.at(-1)?.action).toBeUndefined()
})

// The sidebar row appearing is the answer; a notice is for a sidebar out of sight.
it.each([
  [true, []],
  [false, ['Cloned pantry']]
])('says a clone landed only when the sidebar cannot (sidebar shown: %s)', async (sidebarVisible, said) => {
  const project = { id: 'cloned', name: 'pantry', path: '/code/pantry', baseRef: 'origin/main' }
  const call = vi.spyOn(runtimeClient, 'call').mockResolvedValueOnce(project as never)
  useWorkspaceStore.setState({ sidebarVisible, notices: [] })

  expect(await useWorkspaceStore.getState().cloneProject('https://example.invalid/pantry.git', '')).toBeNull()

  expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toEqual(said)
  expect(useWorkspaceStore.getState().projects.at(-1)?.id).toBe('cloned')
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
  // More than one pane, so focusing the right one is a claim that can fail.
  const worktreeId = panes
    .map((pane) => pane.worktreeId)
    .find((id, _, all) => all.filter((entry) => entry === id).length > 1)!
  const elsewhere = useWorkspaceStore
    .getState()
    .worktrees.find((entry) => entry.state === 'ready' && entry.id !== worktreeId)!

  await store.openWorktree(elsewhere.id)
  store.toggleDashboard()
  expect(useWorkspaceStore.getState().dashboardOpen).toBe(true)

  // Not the pane that already has the focus, so the assertion is about this call.
  const seeded = await runtimeClient.call('layout.get', { worktreeId })
  const target = panes.find((pane) => pane.worktreeId === worktreeId && pane.id !== seeded.focusedTerminalId)!

  await useWorkspaceStore.getState().revealPane(worktreeId, target.id)

  expect(useWorkspaceStore.getState().activeWorktreeId).toBe(worktreeId)
  expect(useWorkspaceStore.getState().layouts[worktreeId]?.focusedTerminalId).toBe(target.id)
  // Picking a row is the answer the view was opened to get, so it gets out of the way.
  expect(useWorkspaceStore.getState().dashboardOpen).toBe(false)
})

it('asks before removing any worktree, and asks the runtime nothing yet', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const clean = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().removeWorktree(clean.id)

  expect(call.mock.calls.filter(([method]) => method === 'worktree.remove')).toEqual([])
  expect(useWorkspaceStore.getState().dialog).toEqual({
    kind: 'confirm-remove',
    worktreeId: clean.id,
    intent: 'remove'
  })
  call.mockRestore()
})

it('asks again on a refusal, without the runtime’s words', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  // A worktree with uncommitted work is exactly the case the runtime refuses.
  const dirty = useWorkspaceStore.getState().worktrees.find((entry) => {
    const status = useWorkspaceStore.getState().statuses[entry.id]
    return entry.state === 'ready' && status !== undefined && status.unstaged + status.staged > 0
  })!

  const call = vi.spyOn(runtimeClient, 'call')
  await useWorkspaceStore.getState().confirmRemoveWorktree(dirty.id, false)

  const attempts = call.mock.calls.filter(([method]) => method === 'worktree.remove')
  expect(attempts.map(([, params]) => params)).toEqual([{ worktreeId: dirty.id }])
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === dirty.id)).toBe(true)
  expect(useWorkspaceStore.getState().dialog).toEqual({
    kind: 'confirm-remove',
    worktreeId: dirty.id,
    intent: 'remove',
    refused: true
  })
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
  await useWorkspaceStore.getState().confirmRemoveWorktree(dirty.id, true)

  expect(call.mock.calls.find(([method]) => method === 'worktree.remove')?.[1]).toEqual({
    worktreeId: dirty.id,
    force: true
  })
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === dirty.id)).toBe(false)
  expect(useWorkspaceStore.getState().dialog).toBeNull()
  call.mockRestore()
})

it('takes the child tasks the question listed, and forgets their rows', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const parent = useWorkspaceStore.getState().worktrees.find((entry) => {
    const status = useWorkspaceStore.getState().statuses[entry.id]
    return entry.state === 'ready' && (status === undefined || status.unstaged + status.staged === 0)
  })!
  const child = await runtimeClient.call('worktree.create', {
    projectId: parent.projectId,
    name: 'a child task',
    parentId: parent.id
  })
  useWorkspaceStore.setState((state) => ({ worktrees: [...state.worktrees, child] }))
  const call = vi.spyOn(runtimeClient, 'call')

  await useWorkspaceStore.getState().confirmRemoveWorktree(parent.id, false)

  expect(call.mock.calls.find(([method]) => method === 'worktree.remove')?.[1]).toEqual({
    worktreeId: parent.id,
    children: true
  })
  const left = useWorkspaceStore.getState().worktrees.map((entry) => entry.id)
  expect(left).not.toContain(parent.id)
  expect(left).not.toContain(child.id)
  call.mockRestore()
})

it('removes a clean worktree once the question is answered', async () => {
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
  await useWorkspaceStore.getState().confirmRemoveWorktree(clean.id, false)

  expect(useWorkspaceStore.getState().dialog).toBeNull()
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === clean.id)).toBe(false)
})

// The CLI panel re-reads on open, so the read is where a stale refusal has to go.
it('does not repeat a CLI refusal to somebody who reopens the panel', async () => {
  useWorkspaceStore.setState({ cliError: 'The administrator password was not given, so nothing was changed.' })

  await useWorkspaceStore.getState().loadCli()

  expect(useWorkspaceStore.getState().cliError).toBeNull()
  expect(useWorkspaceStore.getState().cli).not.toBeNull()
})

// installCli re-reads the destination before it shows what refused it.
it('keeps the refusal of an install that was refused, across the re-read it does', async () => {
  const refused = 'The administrator password was not given, so nothing was changed.'
  const call = vi.spyOn(runtimeClient, 'call').mockRejectedValueOnce(new Error(refused))

  await useWorkspaceStore.getState().installCli()
  call.mockRestore()

  expect(useWorkspaceStore.getState().cliError).toBe(refused)
  expect(useWorkspaceStore.getState().cliPending).toBe(false)
})

// A link made in March and broken in April must not open saying the CLI is
// not on your PATH and, three lines down, that it now points at this app.
it('does not repeat a CLI success line to somebody who reopens the panel', async () => {
  await useWorkspaceStore.getState().installCli()
  expect(useWorkspaceStore.getState().cliInstall).not.toBeNull()

  await useWorkspaceStore.getState().loadCli()

  expect(useWorkspaceStore.getState().cliInstall).toBeNull()
  expect(useWorkspaceStore.getState().cli).not.toBeNull()
})

// The three relay-pane actions, against the store rather than a mock of it.
// The view's tests mock them away, so the rules they enforce are pinned here.
/**
 * Every teamwork pane the seeded runtime is still holding, gone. The runtime is
 * shared by the whole file and a relay pane is rebuilt from its list, so each
 * test has to start from an empty runtime, not only an empty store.
 */
const closeTeamworkTerminals = async (): Promise<void> => {
  const open = await runtimeClient.call('terminal.list', {})
  for (const entry of open) {
    if (teamworkPaneFromWorktreeId(entry.worktreeId) === null) continue
    await runtimeClient.call('terminal.close', { terminalId: entry.id })
  }
}

describe('the relay pane, in the store that owns it', () => {
  const LAUNCHER = '/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy'

  const relaySetting = (projectId: string): RelaySetting => ({
    projectId,
    file: '.teamree/relay',
    url: null,
    source: null,
    problem: 'no .teamree/relay in this project',
    onDisk: { url: null, problem: 'no .teamree/relay in this project' },
    override: { name: 'TEAMREE_RELAY_URL', value: null },
    deploy: { command: LAUNCHER, reason: null },
    readAt: 0
  })

  /** A booted store with a project whose build carries the launcher this panel knows. */
  const ready = async (): Promise<string> => {
    const store = useWorkspaceStore.getState()
    await store.bootstrap()
    await closeTeamworkTerminals()
    const projectId = useWorkspaceStore.getState().projects[0]!.id
    useWorkspaceStore.setState((state) => ({
      relays: { ...state.relays, [projectId]: relaySetting(projectId) },
      relayPanes: {}
    }))
    return projectId
  }

  const paneOf = (projectId: string): RelayPaneState => {
    const pane = useWorkspaceStore.getState().relayPanes[projectId]
    if (pane === undefined) throw new Error('no relay pane')
    return pane
  }

  it('runs the launcher’s verb in a pane of the project’s own, and records which verb it is', async () => {
    const projectId = await ready()
    const call = vi.spyOn(runtimeClient, 'call')

    await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)

    const created = call.mock.calls.find(([method]) => method === 'terminal.create')
    expect((created?.[1] as { command?: string })?.command).toBe(
      '/apps/teamree.app/Contents/Resources/relay/teamree-relay serve'
    )
    expect((created?.[1] as { worktreeId?: string })?.worktreeId).toBe(teamworkPaneWorktreeId(projectId, 'serve'))
    expect(paneOf(projectId)).toMatchObject({ kind: 'serve', url: null, urls: [], running: true })
    expect(useWorkspaceStore.getState().terminals[paneOf(projectId).terminalId]).toBeDefined()
    call.mockRestore()
  })

  // One slot: a second command would replace the output somebody is reading
  // and, for a relay, fight the first for the port.
  it('refuses a second command while one is open', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)
    const first = paneOf(projectId).terminalId

    await useWorkspaceStore.getState().startRelayPane(projectId, 'deploy', undefined)

    expect(paneOf(projectId).terminalId).toBe(first)
    expect(paneOf(projectId).kind).toBe('serve')
  })

  // Without this, a caller could run `teamree-relay check` with no argument
  // in a pane titled as though it were the check somebody asked for.
  it('refuses a check with no URL to dial, the way the disabled button does', async () => {
    const projectId = await ready()
    const call = vi.spyOn(runtimeClient, 'call')

    await useWorkspaceStore.getState().startRelayPane(projectId, 'check', undefined)
    await useWorkspaceStore.getState().startRelayPane(projectId, 'check', '   ')

    expect(call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(0)
    expect(useWorkspaceStore.getState().relayPanes[projectId]).toBeUndefined()
    call.mockRestore()
  })

  it('passes the URL to check as one shell word', async () => {
    const projectId = await ready()
    const call = vi.spyOn(runtimeClient, 'call')

    await useWorkspaceStore.getState().startRelayPane(projectId, 'check', 'wss://relay.example/v1/relay?x=1')

    const created = call.mock.calls.find(([method]) => method === 'terminal.create')
    expect((created?.[1] as { command?: string })?.command).toBe(
      "/apps/teamree.app/Contents/Resources/relay/teamree-relay check 'wss://relay.example/v1/relay?x=1'"
    )
    call.mockRestore()
  })

  it('closes the terminal as well as the slot', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)
    const terminalId = paneOf(projectId).terminalId

    await useWorkspaceStore.getState().closeRelayPane(projectId)

    expect(useWorkspaceStore.getState().relayPanes[projectId]).toBeUndefined()
    expect(await runtimeClient.call('terminal.list', {})).not.toContainEqual(
      expect.objectContaining({ id: terminalId })
    )
  })

  it('takes the address a relay run here printed, and every other one it offered', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)

    useWorkspaceStore
      .getState()
      .noteRelayPane(
        projectId,
        [
          'teamree-relay: on this Mac        ws://127.0.0.1:8787/v1/relay',
          'teamree-relay: on this network    ws://192.168.64.1:8787/v1/relay',
          'teamree-relay: on this network    ws://192.168.1.23:8787/v1/relay',
          'teamree-relay: the URL to give your team:  ws://192.168.64.1:8787/v1/relay'
        ].join('\n'),
        true
      )

    // The one the relay itself offered, which is the last thing it printed.
    expect(paneOf(projectId).url).toBe('ws://192.168.64.1:8787/v1/relay')
    // And all of them: the relay's own source says its pick is a guess.
    expect(paneOf(projectId).urls).toEqual([
      'ws://127.0.0.1:8787/v1/relay',
      'ws://192.168.64.1:8787/v1/relay',
      'ws://192.168.1.23:8787/v1/relay'
    ])
  })

  // A check's first line is `teamree-relay: dialling ws://…`, so a scheme list
  // that let a check yield a URL would offer an address it had just proved dead.
  it('never takes a URL out of a check pane, however plainly the check prints one', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'check', 'ws://192.168.1.23:8787/v1/relay')

    useWorkspaceStore
      .getState()
      .noteRelayPane(
        projectId,
        [
          'teamree-relay: dialling ws://192.168.1.23:8787/v1/relay',
          'teamree-relay: no answer from ws://192.168.1.23:8787/v1/relay — connection refused',
          'teamree-relay: also tried wss://192.168.1.23:8787/v1/relay'
        ].join('\n'),
        false
      )

    expect(paneOf(projectId).url).toBeNull()
    expect(paneOf(projectId).urls).toEqual([])
  })

  // Only the tail of the scrollback is read, and a relay that is working logs
  // the announcement out of that window.
  it('does not forget an address because the relay kept talking', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)
    const note = useWorkspaceStore.getState().noteRelayPane

    note(projectId, 'teamree-relay: the URL to give your team:  ws://192.168.1.23:8787/v1/relay', true)
    note(projectId, '{"at":1,"peer":"ada"}\n{"at":2,"peer":"priya"}\n{"at":3,"peer":"ada"}', true)

    expect(paneOf(projectId).url).toBe('ws://192.168.1.23:8787/v1/relay')
    expect(paneOf(projectId).urls).toEqual(['ws://192.168.1.23:8787/v1/relay'])
  })

  it('still prefers a newer address to the one it is holding', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'deploy', undefined)
    const note = useWorkspaceStore.getState().noteRelayPane

    note(projectId, 'wss://first.workers.dev/v1/relay', true)
    note(projectId, 'wss://first.workers.dev/v1/relay ... redeployed ... wss://second.workers.dev/v1/relay', false)

    expect(paneOf(projectId).url).toBe('wss://second.workers.dev/v1/relay')
    expect(paneOf(projectId).running).toBe(false)
  })

  it('says nothing about a project with no pane open', () => {
    useWorkspaceStore.getState().noteRelayPane('no-such-project', 'ws://192.168.1.23:8787/v1/relay', true)
    expect(useWorkspaceStore.getState().relayPanes['no-such-project']).toBeUndefined()
  })
})

// A renderer reload empties this window's memory and leaves every process the
// runtime started where it was. For a relay the slot is gone, the pane is in no
// tree so nothing can stop it, and the next serve dies on EADDRINUSE.
describe('the relay pane, against the runtime’s own list of terminals', () => {
  const terminal = (id: string, worktreeId: string, running = true): Terminal => ({
    id,
    worktreeId,
    title: 'teamree-relay',
    cwd: '/repos/pager',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running,
    busy: false,
    lastOutputAt: 0
  })

  const listed = (...entries: Terminal[]): Record<string, Terminal> =>
    Object.fromEntries(entries.map((entry) => [entry.id, entry]))

  it('reads the project and the verb back out of the id the pane was made under', () => {
    expect(teamworkPaneFromWorktreeId(teamworkPaneWorktreeId('p1', 'serve'))).toEqual({
      projectId: 'p1',
      kind: 'serve'
    })
    // A project id with a colon in it is still one project id.
    expect(teamworkPaneFromWorktreeId(teamworkPaneWorktreeId('a:b', 'check'))).toEqual({
      projectId: 'a:b',
      kind: 'check'
    })
    expect(teamworkPaneFromWorktreeId('wt_12')).toBeNull()
    expect(teamworkPaneFromWorktreeId('teamwork:p1')).toBeNull()
    expect(teamworkPaneFromWorktreeId('teamwork:publish:p1')).toBeNull()
  })

  it('brings a relay this window has forgotten back into its slot, as the verb it is', () => {
    const rebuilt = reconcileRelayPanes({}, listed(terminal('term_9', teamworkPaneWorktreeId('p1', 'serve'))))
    expect(rebuilt.p1).toEqual({ kind: 'serve', terminalId: 'term_9', url: null, urls: [], running: true })
  })

  // A slot whose only control reads "Close this pane" for a pane that is not there.
  it('drops a slot whose terminal has left the runtime’s list', () => {
    const open: Record<string, RelayPaneState> = {
      p1: { kind: 'serve', terminalId: 'term_9', url: 'ws://192.168.1.23:8787/v1/relay', urls: [], running: true }
    }
    expect(reconcileRelayPanes(open, listed(terminal('term_1', 'wt_1')))).toEqual({})
  })

  // The URL is scraped out of a pane and is in no list, so the slot must keep it.
  it('keeps what an open pane has learned, and takes running off the record', () => {
    const open: Record<string, RelayPaneState> = {
      p1: {
        kind: 'serve',
        terminalId: 'term_9',
        url: 'ws://192.168.1.23:8787/v1/relay',
        urls: ['ws://192.168.1.23:8787/v1/relay'],
        running: true
      }
    }
    const same = reconcileRelayPanes(open, listed(terminal('term_9', teamworkPaneWorktreeId('p1', 'serve'))))
    expect(same).toBe(open)

    const exited = reconcileRelayPanes(open, listed(terminal('term_9', teamworkPaneWorktreeId('p1', 'serve'), false)))
    expect(exited.p1).toEqual({ ...open.p1, running: false })
  })

  it('leaves an ordinary worktree’s terminals alone', () => {
    expect(reconcileRelayPanes({}, listed(terminal('term_1', 'wt_1'), terminal('term_2', 'wt_2')))).toEqual({})
  })

  // Through the store, to prove the reconciliation is wired to the read that replaces the list.
  it('adopts a relay left running by a window that reloaded, and prunes it when it goes', async () => {
    const store = useWorkspaceStore.getState()
    await store.bootstrap()
    await closeTeamworkTerminals()
    const stop = store.startWatching()
    try {
      const projectId = useWorkspaceStore.getState().projects[0]!.id
      useWorkspaceStore.setState((state) => ({
        relays: {
          ...state.relays,
          [projectId]: {
            ...state.relays[projectId]!,
            deploy: { command: '/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy', reason: null }
          }
        },
        relayPanes: {}
      }))
      await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)
      const terminalId = useWorkspaceStore.getState().relayPanes[projectId]!.terminalId

      // The reload: this window's memory of the pane is gone and the process is not.
      useWorkspaceStore.setState({ relayPanes: {} })
      const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
      await useWorkspaceStore.getState().createTerminal(worktreeId)

      await vi.waitFor(() =>
        expect(useWorkspaceStore.getState().relayPanes[projectId]).toMatchObject({
          kind: 'serve',
          terminalId,
          running: true
        })
      )

      // Gone from the runtime is gone from the panel.
      await runtimeClient.call('terminal.close', { terminalId })
      await vi.waitFor(() => expect(useWorkspaceStore.getState().relayPanes[projectId]).toBeUndefined())
    } finally {
      stop()
    }
  })
})

// The strip's `+` menu is built from the store's `agents`, which is whatever
// `agent.list` answered at startup — so the menu offers exactly the agents the
// runtime found, and a machine without one gets no row for it.
it('offers the + menu the agents agent.list reported, in its order', async () => {
  const { startMenuItems } = await import('../workspace/startMenu')
  const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const reported = await runtimeClient.call('agent.list', {})
  expect(reported.length).toBeGreaterThan(0)
  const items = startMenuItems(useWorkspaceStore.getState().agents, resolvePlatformModifier('darwin'), {
    newTerminal: () => {},
    newMarkdown: () => {},
    startAgent: () => {},
    openAgentSettings: () => {}
  })
  expect(items.map((item) => item.label)).toEqual([
    'New Terminal',
    'New Markdown',
    ...reported.map((agent) => harnessName(agent.kind)),
    'Agent Settings…'
  ])
})

describe('opening the settings at a section', () => {
  it('opens the page and names the section, and the toggle forgets it on the way out', () => {
    const store = useWorkspaceStore.getState()
    useWorkspaceStore.setState({ settingsOpen: false, dashboardOpen: true, settingsSection: null })
    store.openSettings('agents')
    expect(useWorkspaceStore.getState().settingsOpen).toBe(true)
    expect(useWorkspaceStore.getState().dashboardOpen).toBe(false)
    expect(useWorkspaceStore.getState().settingsSection).toBe('agents')
    store.toggleSettings()
    expect(useWorkspaceStore.getState().settingsOpen).toBe(false)
    expect(useWorkspaceStore.getState().settingsSection).toBeNull()
  })
})

it('renames a worktree at once, keeps the runtime’s answer, and leaves branch and path alone', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const before = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!

  const renaming = useWorkspaceStore.getState().renameWorktree(before.id, '  the winner ')
  expect(useWorkspaceStore.getState().worktrees.find((entry) => entry.id === before.id)?.name).toBe('the winner')
  await renaming

  const after = useWorkspaceStore.getState().worktrees.find((entry) => entry.id === before.id)!
  expect(after).toEqual({ ...before, name: 'the winner' })
  expect((await runtimeClient.call('worktree.get', { worktreeId: before.id })).name).toBe('the winner')
})

it('puts the old name back when the runtime refuses a rename, and never sends a blank one', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const before = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!
  const call = vi.spyOn(runtimeClient, 'call')

  await useWorkspaceStore.getState().renameWorktree(before.id, '   ')
  expect(call.mock.calls.filter(([method]) => method === 'worktree.rename')).toHaveLength(0)

  call.mockImplementationOnce(() => Promise.reject(new Error('no')))
  await useWorkspaceStore.getState().renameWorktree(before.id, 'refused')

  expect(useWorkspaceStore.getState().worktrees.find((entry) => entry.id === before.id)?.name).toBe(before.name)
  expect(useWorkspaceStore.getState().notices.at(-1)?.text).toBe('Could not rename the worktree: no')
  call.mockRestore()
})
