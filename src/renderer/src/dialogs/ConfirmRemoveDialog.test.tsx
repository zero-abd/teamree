/** @vitest-environment jsdom */

// The one dialog that exists to slow somebody down.
//
// It is never speculative: it appears only after the runtime has already
// refused to remove a checkout, so the question it asks is not "are you sure"
// but "this will be thrown away, and here is what". Everything below is about
// that being true of the rendered thing — that the runtime's own reason is on
// screen, that the two counts git itself would not warn about are spelled out,
// and that the destructive button says which of the two jobs it is doing.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeStatus } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { ConfirmRemoveDialog } = await import('./ConfirmRemoveDialog')

const INITIAL = useWorkspaceStore.getState()

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite-the-pager',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
}

const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})

const REASON = 'this worktree has 3 uncommitted changes and 2 ignored files'

const closeDialog = vi.fn()
const forceRemoveWorktree = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      dialog: { kind: 'confirm-remove', worktreeId: 'w1', reason: REASON, intent: 'remove' },
      closeDialog,
      forceRemoveWorktree,
      ...overrides
    },
    true
  )
}

const mount = (): void => {
  render(<ConfirmRemoveDialog worktreeId="w1" reason={REASON} />)
}

beforeEach(() => {
  closeDialog.mockReset()
  forceRemoveWorktree.mockReset()
  seed()
})

describe('what it says will be lost', () => {
  it('names the worktree in its own title, and gives the runtime’s reason', () => {
    mount()
    expect(screen.getByRole('dialog', { name: 'Discard Rewrite the pager?' })).toBeTruthy()
    expect(screen.getByText(REASON)).toBeTruthy()
    expect(screen.getByText('/repos/pager-wt/rewrite-the-pager')).toBeTruthy()
  })

  it('says how much uncommitted work there is', () => {
    seed({ statuses: { w1: status({ staged: 1, unstaged: 2, untracked: 3, conflicted: 1 }) } })
    mount()
    expect(screen.getByText('7 uncommitted changes')).toBeTruthy()
  })

  it('counts one change as one change', () => {
    seed({ statuses: { w1: status({ unstaged: 1 }) } })
    mount()
    expect(screen.getByText('1 uncommitted change')).toBeTruthy()
  })

  // Git leaves ignored files out of every warning it gives, and this app cannot
  // tell a node_modules it could rebuild from the only copy of a .env.
  it('warns separately about ignored files, which git itself would not mention', () => {
    seed({ statuses: { w1: status({ ignored: 4 }) } })
    mount()
    expect(screen.getByText('4 ignored files or folders')).toBeTruthy()
  })

  it('says nothing about counts it has no status for', () => {
    mount()
    expect(screen.queryByText(/^\d+ uncommitted change/)).toBeNull()
    expect(screen.queryByText(/^\d+ ignored file/)).toBeNull()
  })
})

describe('the two ways out', () => {
  it('keeps the work by default, and closing changes nothing', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(closeDialog).toHaveBeenCalledOnce()
    expect(forceRemoveWorktree).not.toHaveBeenCalled()
  })

  it('discards only on the destructive button, and names the worktree it discards', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Discard the work' }))
    expect(forceRemoveWorktree).toHaveBeenCalledExactlyOnceWith('w1')
  })

  // A retry removes the old checkout only to build a new one in its place, so
  // "Discard the work" followed by a worktree reappearing would read as a bug.
  it('says a retry is a retry, because the worktree comes back', () => {
    seed({ dialog: { kind: 'confirm-remove', worktreeId: 'w1', reason: REASON, intent: 'retry' } })
    mount()
    expect(screen.getByRole('button', { name: 'Discard it and start again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Discard the work' })).toBeNull()
  })

  it('closes on Escape without discarding anything', () => {
    mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closeDialog).toHaveBeenCalledOnce()
    expect(forceRemoveWorktree).not.toHaveBeenCalled()
  })

  // A worktree can go while the question about it is on screen.
  it('still asks the question when the worktree itself has already gone', () => {
    seed({ worktrees: [] })
    mount()
    expect(screen.getByRole('dialog', { name: 'Discard this worktree?' })).toBeTruthy()
    expect(screen.getByText(REASON)).toBeTruthy()
  })
})
