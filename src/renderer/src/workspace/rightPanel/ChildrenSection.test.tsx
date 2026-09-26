/** @vitest-environment jsdom */

// A parent's Children in its Changes panel: each child's state, one-click merges, and where a run stopped.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeMergePreview, WorktreeStatus } from '@shared/entities'

const call = vi.fn()

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

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { useChildren } = await import('./childrenStore')
const { ChildrenSection } = await import('./ChildrenSection')
const { ChangesTab } = await import('./ChangesTab')

const INITIAL = useWorkspaceStore.getState()

const worktree = (id: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name.toLowerCase().replaceAll(' ', '-'),
  path: `/wt/${id}`,
  startedFrom: 'abc',
  state: 'ready',
  createdAt: 0,
  ...extra
})

const status = (worktreeId: string, extra: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId,
  branch: worktreeId,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...extra
})

const preview = (worktreeId: string, extra: Partial<WorktreeMergePreview> = {}): WorktreeMergePreview => ({
  worktreeId,
  baseRef: 'checkout',
  state: 'clean',
  ahead: 1,
  conflicts: [],
  readAt: 0,
  ...extra
})

const done = (summary: string): Worktree['report'] => ({ outcome: 'succeeded', summary, paths: [], at: 0 })

function seed(): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'parent',
      worktrees: [
        worktree('parent', 'Checkout'),
        worktree('cart', 'Cart totals', { parentId: 'parent', report: done('Totals include tax. Tests pass.') }),
        worktree('pay', 'Payment', { parentId: 'parent', report: done('Card payments.') }),
        worktree('search', 'Search page', { parentId: 'parent' }),
        worktree('notes', 'Notes', { parentId: 'parent', report: done('Notes.') })
      ],
      statuses: {
        parent: status('parent'),
        cart: status('cart', { behind: 1 }),
        pay: status('pay'),
        search: status('search', { unstaged: 2 }),
        notes: status('notes')
      },
      mergePreviews: {
        cart: preview('cart', { ahead: 2 }),
        pay: preview('pay', { state: 'conflicts', conflicts: ['money.js'] }),
        search: preview('search', { ahead: 0, state: 'nothingToMerge' }),
        notes: preview('notes')
      },
      changes: { parent: { worktreeId: 'parent', changes: [], total: 0, limit: 500, truncated: false, readAt: 0 } }
    },
    true
  )
}

const rowOf = (name: string): HTMLElement => screen.getByRole('listitem', { name })

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  useChildren.setState({ merging: {}, stopped: {}, reveal: null })
  seed()
})
afterEach(cleanup)

describe('the Children section', () => {
  it('lists each child with its stage, distance, conflict and report, in the parent’s Changes panel', () => {
    render(<ChangesTab />)
    const section = screen.getByRole('region', { name: 'Children' })
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((row) => row.getAttribute('aria-label'))
    ).toEqual(['Cart totals', 'Payment', 'Search page', 'Notes'])
    const cart = rowOf('Cart totals')
    expect(within(cart).getByText('done')).toBeTruthy()
    expect(within(cart).getByText('↑2 ↓1')).toBeTruthy()
    expect(within(cart).getByText('✓ Totals include tax.').getAttribute('title')).toBe(
      'Totals include tax. Tests pass.'
    )
    expect(within(rowOf('Payment')).getByTitle('Conflicts with Checkout in money.js')).toBeTruthy()
    expect(within(rowOf('Search page')).getByText('stopped')).toBeTruthy()
  })

  it('reads each row aloud in words', () => {
    render(<ChildrenSection worktreeId="parent" />)
    expect(
      within(rowOf('Cart totals')).getByRole('button', {
        name: 'Cart totals',
        description: 'done, 2 ahead, 1 behind, reported: Totals include tax.'
      })
    ).toBeTruthy()
    expect(
      within(rowOf('Payment')).getByRole('button', {
        name: 'Payment',
        description: 'done, 1 ahead, would conflict with Checkout in money.js, reported: Card payments.'
      })
    ).toBeTruthy()
    expect(
      within(rowOf('Search page')).getByRole('button', { name: 'Search page', description: 'stopped, 2 uncommitted' })
    ).toBeTruthy()
  })

  it('shows nothing on a task without children', () => {
    useWorkspaceStore.setState({ activeWorktreeId: 'cart' })
    render(<ChildrenSection worktreeId="cart" />)
    expect(screen.queryByRole('region', { name: 'Children' })).toBeNull()
  })

  it('merges one child into the parent with one click', async () => {
    const mergeChildren = vi.fn(async () => true)
    useChildren.setState({ mergeChildren })
    render(<ChildrenSection worktreeId="parent" />)

    const merge = within(rowOf('Cart totals')).getByRole('button', { name: 'Merge' })
    expect(merge.getAttribute('title')).toBe('Merge into Checkout')
    await act(async () => fireEvent.click(merge))

    expect(mergeChildren).toHaveBeenCalledWith('parent', ['cart'])
  })

  it('Merge All Ready lands the done, conflict-free children in order', async () => {
    const mergeChildren = vi.fn(async () => true)
    useChildren.setState({ mergeChildren })
    render(<ChildrenSection worktreeId="parent" />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Merge All Ready' })))

    expect(mergeChildren).toHaveBeenCalledWith('parent', ['cart', 'notes'])
  })

  it('says which child is merging and holds the other buttons', () => {
    useChildren.setState({ merging: { parent: 'cart' } })
    render(<ChildrenSection worktreeId="parent" />)
    expect(within(rowOf('Cart totals')).getByRole('button', { name: 'Merging…' })).toHaveProperty('disabled', true)
    expect(within(rowOf('Notes')).getByRole('button', { name: 'Merge' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Merge All Ready' })).toHaveProperty('disabled', true)
  })

  it('a stop on a conflict says where, and Resolve opens that child’s merge', () => {
    useChildren.setState({
      stopped: {
        parent: { worktreeId: 'pay', error: 'payment conflicts with checkout in money.js', conflicts: ['money.js'] }
      }
    })
    render(<ChildrenSection worktreeId="parent" />)

    expect(screen.getByRole('alert').textContent).toContain('Stopped at Payment: conflicts in money.js')
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }))

    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'pay' })
  })

  it('Resolve… lands in the conflict flow: Update from Parent, not Merge', async () => {
    const { ConfirmMergeDialog } = await import('../../dialogs/ConfirmMergeDialog')
    call.mockImplementation((method: string, params: { dryRun?: boolean; base?: boolean }) => {
      if (method === 'worktree.mergeIntoBase' && params.dryRun === true) {
        return Promise.resolve({
          worktreeId: 'pay',
          into: 'checkout',
          checkout: '/wt/parent',
          commits: [{ shortSha: 'bb47af2', subject: 'Card payments' }],
          fastForward: false,
          dirty: [],
          merged: false,
          conflicts: ['money.js']
        })
      }
      return new Promise(() => {})
    })
    useChildren.setState({
      stopped: {
        parent: { worktreeId: 'pay', error: 'payment conflicts with checkout in money.js', conflicts: ['money.js'] }
      }
    })
    const Shown = (): React.JSX.Element | null => {
      const dialog = useWorkspaceStore((state) => state.dialog)
      return dialog?.kind === 'confirm-merge' ? <ConfirmMergeDialog worktreeId={dialog.worktreeId} /> : null
    }
    render(
      <>
        <ChildrenSection worktreeId="parent" />
        <Shown />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }))

    expect(await screen.findByRole('button', { name: 'Update from Parent' })).toBeTruthy()
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Merge' })).toBeNull()
  })

  it('any other stop opens that child’s merge, where a message can be typed', () => {
    useChildren.setState({
      stopped: { parent: { worktreeId: 'search', error: 'Needs a commit message', conflicts: [] } }
    })
    render(<ChildrenSection worktreeId="parent" />)

    expect(screen.getByRole('alert').textContent).toContain('Stopped at Search page: Needs a commit message')
    fireEvent.click(screen.getByRole('button', { name: 'Merge…' }))

    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'search' })
  })

  it('offers Clean Up for landed children', async () => {
    const confirmCleanUp = vi.fn(async () => {})
    useWorkspaceStore.setState((state) => ({
      confirmCleanUp,
      landings: {
        ...state.landings,
        notes: {
          worktreeId: 'notes',
          branch: 'notes',
          base: 'checkout',
          host: null,
          published: false,
          unmerged: 0,
          merged: true,
          readAt: 0,
          parent: { worktreeId: 'parent', name: 'Checkout' }
        }
      }
    }))
    render(<ChildrenSection worktreeId="parent" />)

    expect(within(rowOf('Notes')).getByText('merged')).toBeTruthy()
    expect(
      document.getElementById(rowOf('Notes').querySelector('.child__name')?.getAttribute('aria-describedby') ?? '')
        ?.textContent
    ).toMatch(/^merged/)
    expect(within(rowOf('Notes')).queryByRole('button', { name: 'Merge' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete 1 Merged' })))

    expect(confirmCleanUp).toHaveBeenCalledWith('p1', ['notes'])
  })

  it('the tally opens the parent on Changes even from the board, where it is already the active one', async () => {
    const openWorktree = vi.fn(async () => {})
    useWorkspaceStore.setState({ openWorktree, rightPanelTab: 'files' })
    await useChildren.getState().showChildren('parent')
    expect(openWorktree).toHaveBeenCalledWith('parent')
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('changes')
    expect(useChildren.getState().reveal).toBe('parent')
  })

  it('scrolls into view when the tally asked for it', () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    useChildren.setState({ reveal: 'parent' })
    render(<ChildrenSection worktreeId="parent" />)
    expect(scrolled).toHaveBeenCalled()
    expect(useChildren.getState().reveal).toBeNull()
  })
})
