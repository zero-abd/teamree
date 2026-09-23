/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeLog, WorktreePush, WorktreeStatus } from '@shared/entities'

const call = vi.fn()
const openInBrowser = vi.fn()

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
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
vi.mock('../../shell/openInBrowser', () => ({ openInBrowser: (url: string) => openInBrowser(url) }))

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { ChangesTab } = await import('./ChangesTab')

const INITIAL = useWorkspaceStore.getState()

const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  upstream: 'origin/rewrite-the-pager',
  ahead: 1,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})

const log: WorktreeLog = {
  worktreeId: 'w1',
  baseRef: 'origin/main',
  commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'A', committedAt: '', subject: 'Rank by recency' }],
  truncated: false,
  readAt: 0
}

const pushed: WorktreePush = {
  worktreeId: 'w1',
  remote: 'origin',
  branch: 'rewrite-the-pager',
  alreadyUpToDate: false,
  upstream: 'origin/rewrite-the-pager',
  setUpstream: false,
  uncommitted: 0,
  reviewUrl: 'https://github.com/team/pager/compare/main...rewrite-the-pager?expand=1',
  pushedAt: 0
}

function seed(overrides: Partial<WorktreeStatus> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'w1',
      changes: { w1: { worktreeId: 'w1', changes: [], total: 0, limit: 500, truncated: false, readAt: 0 } },
      statuses: { w1: status(overrides) },
      logs: { w1: log }
    },
    true
  )
}

/** A push that answers when the test says so. */
function pendingPush(): PromiseWithResolvers<WorktreePush> {
  const push = Promise.withResolvers<WorktreePush>()
  call.mockImplementation((method: string) => (method === 'worktree.push' ? push.promise : new Promise(() => {})))
  return push
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  openInBrowser.mockReset()
  seed()
})

describe('pushing from the changes tab', () => {
  it('pushes, shows it is busy, then offers the review page', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    expect(call).toHaveBeenCalledWith('worktree.push', { worktreeId: 'w1' })
    expect(screen.getByRole('button', { name: 'Pushing…' })).toHaveProperty('disabled', true)

    await act(async () => push.resolve(pushed))
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    expect(openInBrowser).toHaveBeenCalledWith(pushed.reviewUrl)
    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull()
  })

  it('says why a push failed on one line, and offers no force', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.reject(new Error('rejected: non-fast-forward')))

    expect(screen.getByRole('alert').textContent).toBe('rejected: non-fast-forward')
    expect(screen.getByRole('button', { name: 'Push' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: /force/i })).toBeNull()
  })

  it('publishes a branch with no upstream, even with nothing ahead', () => {
    seed({ upstream: null, ahead: 0 })
    render(<ChangesTab />)
    expect(screen.getByRole('button', { name: 'Publish branch' })).toBeTruthy()
  })

  it('offers nothing when the upstream has every commit', () => {
    seed({ ahead: 0 })
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: /push|publish|review/i })).toBeNull()
  })
})

describe('the changes header', () => {
  it('names the branch and how far it is from its upstream, with the push button after', () => {
    seed({ ahead: 1, behind: 2 })
    render(<ChangesTab />)
    const head = screen.getByRole('button', { name: 'Push' }).parentElement as HTMLElement
    expect(head.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager · ↑1 ↓2')
    expect(head.lastElementChild?.textContent).toBe('Push')
  })

  it('counts against the base when the branch tracks nothing, and says what each arrow measures', () => {
    seed({ upstream: null, ahead: 2, behind: 3 })
    render(<ChangesTab />)
    const ref = document.querySelector('.changes__ref') as HTMLElement
    expect(ref.textContent).toBe('rewrite-the-pager · ↑2 ↓3')
    expect(ref.title).toBe('↑ origin/main  ↓ origin/main')
    expect(screen.getByRole('button', { name: 'Publish branch' })).toBeTruthy()
  })
})

describe('ticking every file', () => {
  it('is a checkbox named All, with the count after it', () => {
    seed()
    useWorkspaceStore.setState({
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [
            { path: 'README.md', kind: 'modified', staged: false, unstaged: true },
            { path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true }
          ],
          total: 2,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    })
    render(<ChangesTab />)

    const all = screen.getByRole('checkbox', { name: 'All' })
    expect(screen.getByText('0/2')).toBeTruthy()
    fireEvent.click(all)
    expect(all).toHaveProperty('checked', true)
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.queryByText(/selected/)).toBeNull()
  })
})
