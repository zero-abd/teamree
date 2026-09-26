/** @vitest-environment jsdom */

// Merging a worktree: the commits that go in, how much the branch changes against its base, and a way to read it first.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeChanges, WorktreeMerge } from '@shared/entities'
import { fileLeavesIn, isReviewLeaf } from '@shared/filePane'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useReviewStore } = await import('../review/reviewStore')
const { ConfirmMergeDialog } = await import('./ConfirmMergeDialog')

const INITIAL = useWorkspaceStore.getState()

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'fix typo',
  branch: 'fix-typo',
  path: '/repos/acme-wt/fix-typo',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
}

const plan: WorktreeMerge = {
  worktreeId: 'w1',
  into: 'main',
  checkout: '/repos/acme-api',
  commits: [
    { shortSha: 'f882eef', subject: 'Add usage section' },
    { shortSha: '6c1738c', subject: 'Fix README typo' }
  ],
  fastForward: true,
  dirty: [],
  merged: false
}

const branch: WorktreeChanges = {
  worktreeId: 'w1',
  changes: [
    { path: 'README.md', kind: 'modified', staged: false, unstaged: false, added: 5, removed: 1 },
    { path: 'src/app.ts', kind: 'modified', staged: false, unstaged: false, added: 36, removed: 6 },
    { path: 'logo.png', kind: 'added', staged: false, unstaged: false }
  ],
  total: 3,
  limit: 500,
  truncated: false,
  readAt: 0
}

beforeEach(() => {
  call.mockImplementation((method: unknown, params: unknown) => {
    if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
    if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
    return new Promise(() => {})
  })
  useReviewStore.setState({ scope: { w1: 'uncommitted' }, jump: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      dialog: { kind: 'confirm-merge', worktreeId: 'w1' }
    },
    true
  )
})

it('says how much the branch changes against its base, beside the commits', async () => {
  render(<ConfirmMergeDialog worktreeId="w1" />)
  await waitFor(() => expect(screen.getByText('3 files +41 −7')).toBeTruthy())
  expect(screen.getByText('6c1738c Fix README typo')).toBeTruthy()
})

it('reviews the whole branch instead of merging it', async () => {
  render(<ConfirmMergeDialog worktreeId="w1" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  expect(useWorkspaceStore.getState().dialog).toBeNull()
  expect(fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root).filter(isReviewLeaf)).toHaveLength(1)
  expect(useReviewStore.getState().scope.w1).toBe('branch')
  expect(call).not.toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' })
})
