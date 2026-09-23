import { describe, expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

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
  expect(changesOnScreen(useWorkspaceStore.getState())).toBe(false)
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
  // Two, and exactly two: the working-tree patch and the index's. Which half a
  // hunk came out of is what decides whether it can be staged or unstaged, and
  // one read cannot answer that.
  expect(diffCalls()).toBe(2)
  expect(useWorkspaceStore.getState().diff?.patch).toContain('diff --git')

  // Picking the same row again clears it, and clearing costs no call.
  useWorkspaceStore.getState().selectChange(null)
  expect(useWorkspaceStore.getState().diff).toBeNull()
  expect(diffCalls()).toBe(2)
  call.mockRestore()
})

it('does not carry one worktree’s patch across to another worktree', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const ready = useWorkspaceStore.getState().worktrees.filter((entry) => entry.state === 'ready')
  const [first, second] = [ready[0]!, ready[1]!]

  await store.openWorktree(first.id)
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
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
  if (!changesOnScreen(useWorkspaceStore.getState())) useWorkspaceStore.getState().toggleChanges()
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

// News goes stale. "Added repo" was still on screen twenty minutes and two
// dozen interactions later, under every notice raised since; nothing but the
// dismiss button ever retired one. An informational notice with nothing to do
// about it leaves on its own. Errors stay, and so does anything with a button.
describe('how long a notice stays', () => {
  it('retires plain news after a while, and keeps errors and offers', async () => {
    vi.useFakeTimers()
    // The seeded runtime answers after a short sleep, which fake timers would
    // hold forever: each call is awaited with the clock moving under it, by
    // far less than a notice's lifetime.
    const settle = async <T>(work: Promise<T>): Promise<T> => {
      await vi.advanceTimersByTimeAsync(500)
      return work
    }
    try {
      const store = useWorkspaceStore.getState()
      await settle(store.bootstrap())
      const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
      await settle(store.openWorktree(worktreeId))

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

      await settle(useWorkspaceStore.getState().removeWorktree(worktreeId))
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

// The push result is the only place that knows a review became possible, so
// the notice it raises is the only place that can offer to open one.
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

  await useWorkspaceStore.getState().pushActiveWorktree()

  expect(useWorkspaceStore.getState().notices.at(-1)?.action).toEqual({ label: 'Open review', url })
  call.mockRestore()
})

// A remote that is not a forge teamree can name is an ordinary push, and the
// notice says exactly as much as it did before.
it('offers nothing to open when the push named no review page', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  await store.openWorktree(worktreeId)

  await useWorkspaceStore.getState().pushActiveWorktree()

  expect(useWorkspaceStore.getState().notices.at(-1)?.action).toBeUndefined()
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

// The other outcome that belongs to the attempt that earned it. A link made in
// March and broken in April leaves a panel that opens saying the CLI is not on
// your PATH and, three lines down, that it now points at this app.
it('does not repeat a CLI success line to somebody who reopens the panel', async () => {
  await useWorkspaceStore.getState().installCli()
  expect(useWorkspaceStore.getState().cliInstall).not.toBeNull()

  await useWorkspaceStore.getState().loadCli()

  expect(useWorkspaceStore.getState().cliInstall).toBeNull()
  expect(useWorkspaceStore.getState().cli).not.toBeNull()
})

// The three relay-pane actions, against the store rather than against a mock of
// it.
//
// They had no tests at all: the view's tests mock them away, and the panel's
// render them out of props, so every rule they enforce — one pane at a time,
// which verb may yield a URL, what a closed pane leaves behind — was enforced
// by nothing that would notice if it stopped. The one that matters most is the
// scheme list: a check pane's scrollback says `teamree-relay: dialling ws://…`
// in so many words, and the panel would offer that URL as a relay to write into
// everybody's repository.
/**
 * Every teamwork pane the seeded runtime is still holding, gone.
 *
 * The runtime in these tests is one object shared by the whole file, and a
 * relay pane is now rebuilt from its list — so a pane a previous test started
 * and did not close is a pane the next test finds on screen. That is the
 * reconciliation doing exactly what it is for, and it is also why each of these
 * has to start from an empty runtime rather than only from an empty store.
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

  // One slot. A second command would replace the output somebody is reading,
  // and for a relay it would also fight the first one for the port.
  it('refuses a second command while one is open', async () => {
    const projectId = await ready()
    await useWorkspaceStore.getState().startRelayPane(projectId, 'serve', undefined)
    const first = paneOf(projectId).terminalId

    await useWorkspaceStore.getState().startRelayPane(projectId, 'deploy', undefined)

    expect(paneOf(projectId).terminalId).toBe(first)
    expect(paneOf(projectId).kind).toBe('serve')
  })

  // The check button is disabled when there is nothing to dial, and that used
  // to be the only thing standing between a caller and `teamree-relay check`
  // with no argument — which is not the check anybody asked for, in a pane
  // titled as though it were.
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
    // And all of them, so the person who knows their own network can take a
    // different one: the relay's own source says its pick is a guess.
    expect(paneOf(projectId).urls).toEqual([
      'ws://127.0.0.1:8787/v1/relay',
      'ws://192.168.64.1:8787/v1/relay',
      'ws://192.168.1.23:8787/v1/relay'
    ])
  })

  // The one that nothing caught. A check prints the URL it was handed, and its
  // very first line is `teamree-relay: dialling ws://…` — so a scheme list that
  // let a check yield a URL would put the address the check had just proved
  // dead under a button offering to write it into everybody's repository.
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

  // Only the tail of the scrollback is read, and a relay that is working logs.
  // Give it long enough and the announcement scrolls out of that window — and
  // the button somebody was about to press used to vanish out from under them.
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
// runtime started exactly where it was. For a deploy that did not matter — it
// had finished. For a relay it matters a great deal: the slot is gone, the
// buttons come back enabled, the pane is in no pane tree so there is no way
// left to stop it, and the next serve dies on EADDRINUSE against a process
// nothing on screen admits to.
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

  // The other way round: a slot whose only control reads "Close this pane" for
  // a pane that is not there.
  it('drops a slot whose terminal has left the runtime’s list', () => {
    const open: Record<string, RelayPaneState> = {
      p1: { kind: 'serve', terminalId: 'term_9', url: 'ws://192.168.1.23:8787/v1/relay', urls: [], running: true }
    }
    expect(reconcileRelayPanes(open, listed(terminal('term_1', 'wt_1')))).toEqual({})
  })

  // Everything the slot has learned is in the slot and nowhere else — the URL
  // above all, which is scraped out of a pane and is not in any list.
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

  // And the whole of it through the store, because the reconciliation is only
  // worth anything if it is actually wired to the read that replaces the list.
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

      // The reload: this window's memory of the pane is gone and the process is
      // not. The next read of the list is what has to notice.
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

      // And gone from the runtime is gone from the panel: a slot offering to
      // close a pane that is not there is a button that can only fail.
      await runtimeClient.call('terminal.close', { terminalId })
      await vi.waitFor(() => expect(useWorkspaceStore.getState().relayPanes[projectId]).toBeUndefined())
    } finally {
      stop()
    }
  })
})
