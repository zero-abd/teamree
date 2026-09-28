/** @vitest-environment jsdom */

// A group per teammate: their face and state on one row that folds, their worktrees under it; and the
// worktrees handed to you, waiting with Take and Dismiss.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerPane, TeammateWorktree } from '@shared/entities'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { teammateRows } = await import('./teammateRows')
const { teamGlance } = await import('./teamGlance')
const { TeammateGroups, HandoffRows } = await import('./TeammateGroups')
const { useTeamFold } = await import('./teamFold')
const { useHandoffs } = await import('../teamwork/handoffsStore')

const NOW = 1_700_000_000_000

const pane = (overrides: Partial<PeerPane> = {}): PeerPane => ({
  id: 'bo:t1',
  title: 'claude',
  shell: '/bin/zsh',
  agent: 'claude',
  running: true,
  busy: true,
  quietForMs: 0,
  ...overrides
})

const theirs = (overrides: Partial<TeammateWorktree> = {}): TeammateWorktree => ({
  id: 'bo:w1',
  name: 'cart-totals',
  branch: 'cart-totals',
  state: 'ready',
  panes: [pane()],
  handle: 'bo',
  publicKey: 'bo-key',
  heardAt: NOW,
  live: true,
  ...overrides
})

function mount(worktrees: TeammateWorktree[], narrowing = false): void {
  const rows = teammateRows(worktrees, NOW)
  render(
    <ul>
      <TeammateGroups
        projectId="p1"
        glance={teamGlance(undefined, undefined, rows, NOW)}
        rows={rows}
        narrowing={narrowing}
        watchingPaneIds={[]}
        onWatch={() => {}}
        onAnswer={() => {}}
        overlapOf={() => null}
      />
    </ul>
  )
}

beforeEach(() => {
  useTeamFold.setState({ folded: {} })
  call.mockReset()
})
afterEach(cleanup)

describe('TeammateGroups', () => {
  const worktrees = [
    theirs(),
    theirs({
      id: 'bo:w2',
      name: 'retry-payment',
      branch: 'retry-payment',
      panes: [pane({ id: 'bo:t2', asking: true })]
    }),
    theirs({ id: 'ana:w1', name: 'receipts', handle: 'ana', publicKey: 'ana-key', panes: [] })
  ]

  it('puts each teammate’s worktrees under one row that says who, and what their agents are doing', () => {
    mount(worktrees)
    const heads = [...document.querySelectorAll<HTMLElement>('.teammate__head')]
    expect(heads.map((head) => head.getAttribute('aria-label'))).toEqual([
      'ana, online · 1 worktree',
      'bo, online · 1 asking · 1 working'
    ])
    const bo = document.querySelector('[data-teammate="bo"]') as HTMLElement
    expect(within(bo).getByText('cart-totals')).toBeTruthy()
    expect(within(bo).getByText('retry-payment')).toBeTruthy()
    // On screen, asking in amber, else whether they are here; the name above has the rest.
    expect(bo.querySelector('.teammate__doing--asking')?.textContent).toBe('1 asking')
    const ana = document.querySelector('[data-teammate="ana"]') as HTMLElement
    expect(ana.querySelector('.teammate__doing--online')?.textContent).toBe('online')
  })

  it('folds a teammate by their row and keeps what they are doing on it', () => {
    mount(worktrees)
    const head = screen.getByRole('treeitem', { name: /^bo,/ })
    act(() => fireEvent.click(head))
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('retry-payment')).toBeNull()
    expect(head.textContent).toContain('1 asking')
    act(() => fireEvent.keyDown(head, { key: 'ArrowRight' }))
    expect(screen.getByText('retry-payment')).toBeTruthy()
  })

  it('opens every group while a filter narrows the list', () => {
    useTeamFold.getState().setFolded('p1', 'bo', true)
    mount(worktrees, true)
    expect(screen.getByText('retry-payment')).toBeTruthy()
  })

  it('says once, on the group, that a teammate is away and how long since they were heard', () => {
    mount([theirs({ live: false, heardAt: NOW - 36_000 })])
    const head = screen.getByRole('treeitem', { name: /^bo,/ })
    expect(head.querySelector('.teammate__doing--away')?.textContent).toBe('away')
    expect(head.getAttribute('data-tip')).toBe('bo’s machine is not connected · showing what it had 36s ago')
  })
})

describe('HandoffRows', () => {
  const offer = {
    id: 'h1',
    to: 'ana',
    from: 'bo',
    worktreeName: 'refund-flow',
    branch: 'refund-flow',
    note: 'Red tests',
    at: NOW
  }

  it('lists an offer as a row with who it is from, and Dismiss drops it', async () => {
    useHandoffs.setState({ byProject: { p1: { incoming: [offer], outgoing: [] } } })
    call.mockResolvedValue({ dismissed: true })
    render(
      <ul>
        <HandoffRows projectId="p1" />
      </ul>
    )
    const row = screen.getByRole('treeitem', { name: /refund-flow/ })
    expect(row.getAttribute('data-tip')).toBe('Red tests')
    expect(row.dataset.handoff).toBe('h1')
    expect(within(row).getByText('from bo')).toBeTruthy()
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' })))
    expect(call).toHaveBeenCalledWith('teamwork.dismissHandoff', { projectId: 'p1', id: 'h1' })
    expect(screen.queryByRole('treeitem', { name: /refund-flow/ })).toBeNull()
  })

  it('draws nothing with no offers waiting', () => {
    useHandoffs.setState({ byProject: {} })
    const { container } = render(<HandoffRows projectId="p1" />)
    expect(container.innerHTML).toBe('')
  })
})
