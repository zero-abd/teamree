/** @vitest-environment jsdom */

// A teammate's comments on your task: a popup that opens its review, and the comments above the patch,
// sent to the task's agent the way your own comments are.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal, Worktree } from '@shared/entities'
import type { ReceivedReview } from '@shared/teammateReview'

const call = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ written: true }))

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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useReviewStore } = await import('./reviewStore')
const { useReceivedReviews, reviewPopups } = await import('../teamwork/receivedReviewsStore')
const { ReviewPopups } = await import('../teamwork/ReviewPopups')
const { useReviewRequests } = await import('../teamwork/reviewRequestsStore')
const { useTeammateReview } = await import('./teammateReviewStore')
const { ReceivedReviews } = await import('./ReceivedReviews')
const { pasted } = await import('./reviewComments')

const INITIAL = useWorkspaceStore.getState()

const review = (over: Partial<ReceivedReview> = {}): ReceivedReview => ({
  id: 'r1',
  projectId: 'p1',
  worktreeId: 'w1',
  handle: 'ada',
  publicKey: 'adakey',
  comments: [
    {
      path: 'footer.txt',
      lines: [{ kind: 'added', text: 'new', oldNumber: null, newNumber: 2 }],
      note: 'Say the brand name'
    }
  ],
  sentAt: 1,
  receivedAt: 10,
  seen: false,
  ...over
})

const claude = {
  id: 'claude',
  worktreeId: 'w1',
  title: 'claude',
  shell: '/bin/zsh',
  running: true,
  busy: false,
  agent: 'claude',
  lastOutputAt: 0
} as unknown as Terminal

beforeEach(() => {
  call.mockClear()
  useReviewStore.setState({ viewed: {}, batch: {}, queued: {}, scope: {}, jump: {} })
  useReceivedReviews.setState({ reviews: [review()] })
  useReviewRequests.setState({ byProject: {} })
  useTeammateReview.setState({ open: [], batch: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'w1',
      worktrees: [{ id: 'w1', projectId: 'p1', name: 'fix footer copy', state: 'ready' } as unknown as Worktree],
      terminals: { claude }
    },
    true
  )
})

afterEach(() => {
  cleanup()
})

describe('a teammate’s review of your task', () => {
  it('pops up unseen reviews oldest first, three at a time', () => {
    const many = [5, 1, 4, 2, 3].map((at) => review({ id: `r${at}`, receivedAt: at }))
    expect(reviewPopups([...many, review({ id: 'old', receivedAt: 0, seen: true })]).map((r) => r.id)).toEqual([
      'r1',
      'r2',
      'r3'
    ])
  })

  it('says who reviewed which task, and Open retires it and opens the review', async () => {
    const opened = vi.spyOn(useReviewStore.getState(), 'reviewBranch')
    render(<ReviewPopups />)
    expect(screen.getByText(/ada reviewed/).textContent).toBe('ada reviewed fix footer copy')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(opened).toHaveBeenCalledWith('w1')
    expect(call).toHaveBeenCalledWith('teamwork.settleReview', { id: 'r1', how: 'seen' })
    await waitFor(() => expect(screen.queryByText(/ada reviewed/)).toBeNull())
  })

  it('lists the comments over the task’s review and sends them to its agent', async () => {
    render(<ReceivedReviews worktreeId="w1" />)
    expect(screen.getByText('footer.txt:2')).toBeTruthy()
    expect(screen.getByText('Say the brand name')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const writes = call.mock.calls.filter(([method]) => method === 'terminal.write').map(([, params]) => params)
    expect(writes).toEqual([
      { terminalId: 'claude', data: pasted('footer.txt:2\n```diff\n+new\n```\nSay the brand name') },
      { terminalId: 'claude', data: '\r' }
    ])
    expect(call).toHaveBeenCalledWith('teamwork.settleReview', { id: 'r1', how: 'closed' })
    expect(screen.queryByText('Say the brand name')).toBeNull()
  })

  it('shows nothing on a task nobody reviewed', () => {
    render(<ReceivedReviews worktreeId="w2" />)
    expect(document.querySelector('.review__received')).toBeNull()
  })
})

describe('a teammate asking you for a review', () => {
  const request = {
    id: 'q1',
    to: 'me',
    from: 'ben',
    worktreeId: 'peer:benkey:wt_fix',
    worktreeName: 'fix footer copy',
    branch: 'fix-footer-copy',
    at: 5
  }

  it('pops up once, and Review opens their task beside the workspace', async () => {
    useReceivedReviews.setState({ reviews: [] })
    useReviewRequests.setState({ byProject: { p1: { incoming: [request], outgoing: [] } } })
    render(<ReviewPopups />)
    expect(screen.getByText(/asks you to review/).textContent).toBe('ben asks you to review fix footer copy')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(useTeammateReview.getState().open).toEqual([
      { projectId: 'p1', worktreeId: 'peer:benkey:wt_fix', title: 'ben · fix footer copy' }
    ])
    expect(call).toHaveBeenCalledWith('teamwork.settleReviewRequest', { projectId: 'p1', id: 'q1', how: 'opened' })
    await waitFor(() => expect(screen.queryByText(/asks you to review/)).toBeNull())
  })
})
