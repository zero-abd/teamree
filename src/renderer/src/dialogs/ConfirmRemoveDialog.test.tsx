/** @vitest-environment jsdom */

// Moving a worktree to the Trash: the question names it, lists what would go, and never shows the runtime's own words.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeChange, WorktreeStatus } from '@shared/entities'

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
const { ConfirmRemoveDialog } = await import('./ConfirmRemoveDialog')
const { detectPlatform, resolvePlatformModifier } = await import('../keyboard/platformModifier')

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
  ignored: 0,
  readAt: 0,
  ...overrides
})

const modified = (path: string): WorktreeChange => ({ path, kind: 'modified', staged: false, unstaged: true })

const closeDialog = vi.fn()
const confirmRemoveWorktree = vi.fn()

/** What the runtime answers when the dialog asks about the checkout. */
function runtimeHas(read: { status?: WorktreeStatus; changes?: WorktreeChange[]; total?: number }): void {
  call.mockImplementation((method: unknown) => {
    if (method === 'worktree.status') return Promise.resolve(read.status ?? status())
    if (method === 'worktree.changes') {
      const changes = read.changes ?? []
      return Promise.resolve({
        worktreeId: 'w1',
        changes,
        total: read.total ?? changes.length,
        limit: 5,
        truncated: false,
        readAt: 0
      })
    }
    return new Promise(() => {})
  })
}

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      dialog: { kind: 'confirm-remove', worktreeId: 'w1', intent: 'remove' },
      closeDialog,
      confirmRemoveWorktree,
      ...overrides
    },
    true
  )
}

const mount = async (): Promise<void> => {
  render(<ConfirmRemoveDialog worktreeId="w1" />)
  await act(async () => undefined)
}

const listed = (): string[] =>
  [...document.querySelectorAll('.confirm__files li')].map((item) => item.textContent ?? '')

beforeEach(() => {
  closeDialog.mockReset()
  confirmRemoveWorktree.mockReset()
  runtimeHas({})
  seed()
})

describe('what it asks', () => {
  it('names the worktree as the sidebar does, with the path only in the title’s tooltip', async () => {
    await mount()
    const dialog = screen.getByRole('dialog', { name: 'Move "Rewrite the pager" to Trash?' })
    expect(screen.getByRole('heading').getAttribute('title')).toBe('/repos/pager-wt/rewrite-the-pager')
    expect(dialog.textContent).not.toContain('/repos/pager-wt')
  })

  it('names one of a task’s runs by the task, its agent after it in words', async () => {
    const run = { ...worktree, name: 'Rewrite the pager to stream codex', branch: 'rewrite-the-pager-to-stream-codex' }
    seed({ worktrees: [{ ...run, task: 'Rewrite the pager to stream' }] })
    await mount()
    expect(screen.getByRole('dialog', { name: 'Move "Rewrite the pager to stream" (Codex) to Trash?' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/codex ·|claude ·/u)
  })

  it('lists the uncommitted files, five at most, then how many more', async () => {
    const changes = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(modified)
    runtimeHas({ status: status({ unstaged: 7 }), changes, total: 7 })
    await mount()
    expect(listed()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', '+2 more'])
  })

  it('counts the ignored files git would delete and the commits not pushed', async () => {
    runtimeHas({ status: status({ ignored: 3, ahead: 1 }) })
    await mount()
    expect(listed()).toEqual(['3 ignored files or folders', '1 unpushed commit'])
  })

  // Merged into its base, its commits are there already; what is uncommitted still goes.
  it('leaves the commits out once the branch has landed, and still lists what is uncommitted', async () => {
    runtimeHas({ status: status({ ahead: 1, unstaged: 1 }), changes: [modified('a.ts')] })
    seed({
      landings: {
        w1: {
          worktreeId: 'w1',
          branch: 'rewrite-the-pager',
          base: 'main',
          host: null,
          published: true,
          unmerged: 0,
          merged: true,
          readAt: 0
        }
      }
    })
    await mount()
    expect(listed()).toEqual(['a.ts'])
  })

  it('lists nothing for a clean worktree with nothing to push', async () => {
    await mount()
    expect(document.querySelector('.confirm__files')).toBeNull()
    expect(document.querySelector('.confirm__body')).toBeNull()
  })

  it('still asks when the worktree itself has already gone', async () => {
    seed({ worktrees: [] })
    await mount()
    expect(screen.getByRole('dialog', { name: 'Move this worktree to Trash?' })).toBeTruthy()
  })
})

describe('the answers', () => {
  it('offers Cancel, focused, and Move to Trash in red', async () => {
    await mount()
    const buttons = [...document.querySelectorAll('.modal__actions .button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel', 'Move to Trash'])
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(buttons[1]?.classList.contains('button--danger')).toBe(true)
  })

  it('removes a clean worktree without force, so the runtime still gets to refuse', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    expect(confirmRemoveWorktree).toHaveBeenCalledExactlyOnceWith('w1', false)
  })

  it('forces only once it has shown what would be lost', async () => {
    runtimeHas({ status: status({ unstaged: 1 }), changes: [modified('a.ts')] })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    expect(confirmRemoveWorktree).toHaveBeenCalledExactlyOnceWith('w1', true)
  })

  it('forces after a refusal, whatever it could read', async () => {
    seed({ dialog: { kind: 'confirm-remove', worktreeId: 'w1', intent: 'remove', refused: true } })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    expect(confirmRemoveWorktree).toHaveBeenCalledExactlyOnceWith('w1', true)
  })

  it('confirms on the modifier and Delete, as Finder does', async () => {
    await mount()
    const modifier = resolvePlatformModifier(detectPlatform(undefined, navigator.userAgent))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Backspace', [modifier.eventFlag]: true })
    expect(confirmRemoveWorktree).toHaveBeenCalledOnce()
  })

  it('cancels on Escape and on Cancel without removing anything', async () => {
    await mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(closeDialog).toHaveBeenCalledTimes(2)
    expect(confirmRemoveWorktree).not.toHaveBeenCalled()
  })

  // The checkout comes back, so the button says so.
  it('says a retry is a retry', async () => {
    seed({ dialog: { kind: 'confirm-remove', worktreeId: 'w1', intent: 'retry' } })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Remove and Retry' }))
    expect(confirmRemoveWorktree).toHaveBeenCalledExactlyOnceWith('w1', true)
  })
})
