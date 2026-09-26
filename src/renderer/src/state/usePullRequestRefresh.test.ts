/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeLanding } from '@shared/entities'

const call = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('./workspaceStore')
const { usePullRequestRefresh } = await import('./usePullRequestRefresh')
const { PENDING_POLL_MS } = await import('./pullRequestRefresh')

const INITIAL = useWorkspaceStore.getState()

const landing = (pending: number): WorktreeLanding => ({
  worktreeId: 'w1',
  branch: 'b',
  base: 'main',
  host: 'github',
  published: true,
  unmerged: 1,
  merged: false,
  readAt: 0,
  pullRequest: {
    number: 1,
    url: 'u',
    state: 'open',
    checks: { passing: 1 - pending, failing: 0, pending, list: [] }
  }
})

function seed(pending: number, fetchInBackground?: boolean): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [
        {
          id: 'p1',
          name: 'p',
          path: '/p',
          baseRef: 'origin/main',
          ...(fetchInBackground === false ? { fetchInBackground } : {})
        }
      ],
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'w',
          branch: 'b',
          path: '/w',
          startedFrom: 's',
          state: 'ready',
          createdAt: 0
        }
      ],
      landings: { w1: landing(pending) }
    },
    true
  )
}

const freshReads = (): unknown[] =>
  call.mock.calls.filter(([method, params]) => method === 'worktree.landing' && (params as { fresh?: boolean }).fresh)

beforeEach(() => {
  vi.useFakeTimers()
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePullRequestRefresh', () => {
  it('asks again once a minute while checks are pending, and not once they are done', () => {
    seed(1)
    renderHook(() => usePullRequestRefresh())
    vi.advanceTimersByTime(PENDING_POLL_MS)
    expect(freshReads()).toEqual([['worktree.landing', { worktreeId: 'w1', fresh: true }]])

    useWorkspaceStore.setState({ landings: { w1: landing(0) } })
    vi.advanceTimersByTime(PENDING_POLL_MS)
    expect(freshReads()).toHaveLength(1)
  })

  it('asks again when the window takes focus', () => {
    seed(0)
    renderHook(() => usePullRequestRefresh())
    window.dispatchEvent(new Event('focus'))
    expect(freshReads()).toHaveLength(1)
  })

  it('asks nothing in the background for a project with background fetching off', () => {
    seed(1, false)
    renderHook(() => usePullRequestRefresh())
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(PENDING_POLL_MS * 3)
    expect(freshReads()).toEqual([])
  })
})
