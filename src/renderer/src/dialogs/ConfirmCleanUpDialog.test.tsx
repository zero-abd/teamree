/** @vitest-environment jsdom */

// Clean Up Merged's checklist: everything that can go starts checked, what must stay is shown and cannot be
// checked, and a child never stays behind without its parent staying too.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree, WorktreeCleanup } from '@shared/entities'

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
const { ConfirmCleanUpDialog } = await import('./ConfirmCleanUpDialog')

const INITIAL = useWorkspaceStore.getState()

const project: Project = { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'main' }
const worktree = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name: id,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  ...extra
})
const parent = worktree('parent')
const child = worktree('child', { parentId: 'parent' })
const other = worktree('other')
const dirty = worktree('dirty')

const confirmCleanUp = vi.fn()
const closeDialog = vi.fn()

function answer(cleanup: Omit<WorktreeCleanup, 'projectId' | 'dryRun'>): void {
  call.mockImplementation((method: unknown) =>
    method === 'worktree.cleanMerged'
      ? Promise.resolve({ projectId: 'p1', dryRun: true, ...cleanup })
      : new Promise(() => {})
  )
}

beforeEach(() => {
  call.mockReset()
  confirmCleanUp.mockReset()
  closeDialog.mockReset()
  answer({
    removed: [{ worktree: child }, { worktree: parent }, { worktree: other, ignored: 3 }],
    kept: [{ worktree: dirty, reason: 'Uncommitted changes' }]
  })
  useWorkspaceStore.setState(
    { ...INITIAL, projects: [project], worktrees: [parent, child, other, dirty], confirmCleanUp, closeDialog },
    true
  )
})

const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement
const confirmButton = (): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.modal__actions .button')].at(-1) as HTMLButtonElement

async function open(): Promise<void> {
  render(<ConfirmCleanUpDialog projectId="p1" />)
  await act(async () => undefined)
}

describe('Clean Up Merged', () => {
  it('asks the runtime for a dry run and checks everything that can go', async () => {
    await open()

    expect(call).toHaveBeenCalledWith('worktree.cleanMerged', { projectId: 'p1', dryRun: true })
    expect([box('parent'), box('child'), box('other')].map((input) => input.checked)).toEqual([true, true, true])
    expect(box('dirty').disabled).toBe(true)
    expect(box('dirty').checked).toBe(false)
    expect(screen.getByText('Uncommitted changes')).toBeTruthy()
    expect(screen.getByText('3 ignored')).toBeTruthy()
    expect(confirmButton().textContent).toBe('Remove 3')
  })

  it('unchecks the parent with its child, and checks the child with its parent', async () => {
    await open()

    fireEvent.click(box('child'))
    expect([box('parent').checked, box('child').checked]).toEqual([false, false])
    expect(confirmButton().textContent).toBe('Remove 1')

    fireEvent.click(box('parent'))
    expect([box('parent').checked, box('child').checked]).toEqual([true, true])
  })

  it('keeps a worktree with unsaved files, and so its parent', async () => {
    useWorkspaceStore.setState({ editedFiles: { 'file:a': { worktreeId: 'child', path: 'a.ts' } } })
    await open()

    expect([box('child').disabled, box('parent').disabled]).toEqual([true, true])
    expect(screen.getByText('Unsaved files')).toBeTruthy()
    expect(screen.getByText('Child stays')).toBeTruthy()
    expect(confirmButton().textContent).toBe('Remove 1')
  })

  it('removes the checked ones', async () => {
    await open()
    fireEvent.click(box('other'))
    fireEvent.click(confirmButton())

    expect(confirmCleanUp).toHaveBeenCalledWith('p1', ['parent', 'child'])
  })

  it('says when there is nothing to clean up', async () => {
    answer({ removed: [], kept: [] })
    await open()

    expect(screen.getByText('Nothing to clean up')).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
  })
})
