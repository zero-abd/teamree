/** @vitest-environment jsdom */

// Offers a teammate made: "<name> handed you <task>" with Take and Dismiss, and the sender row's one line.

import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerHandoff, TeamworkHandoffs } from '@shared/tasks'

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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { handoffLine, useHandoffs } = await import('./handoffsStore')
const { HandoffPopups } = await import('./HandoffPopups')

const INITIAL = useWorkspaceStore.getState()

const offer = (id: string, over: Partial<PeerHandoff> = {}): PeerHandoff => ({
  id,
  to: 'bo',
  from: 'ana',
  worktreeName: `Task ${id}`,
  branch: id,
  note: 'Finish it.',
  at: Number(id.slice(1)),
  ...over
})

let reads: Record<string, TeamworkHandoffs>

beforeEach(() => {
  reads = { p1: { incoming: [offer('h2'), offer('h1')], outgoing: [] } }
  call.mockReset()
  call.mockImplementation(async (method: string, params: { projectId: string; id?: string }) => {
    if (method === 'teamwork.handoffs') return reads[params.projectId] ?? { incoming: [], outgoing: [] }
    if (method === 'teamwork.take') return { id: 'wt_taken' }
    if (method === 'teamwork.dismissHandoff') return { dismissed: true }
    return undefined
  })
  useWorkspaceStore.setState({ ...INITIAL }, true)
  useHandoffs.setState({ byProject: {} })
})

const lines = (view: ReturnType<typeof render>): string[] =>
  [...view.container.querySelectorAll('.notice__text')].map((line) => line.textContent ?? '')

describe('an offer from a teammate', () => {
  it('says who handed what, oldest first', async () => {
    await useHandoffs.getState().refresh(['p1'])
    const view = render(<HandoffPopups />)
    expect(lines(view)).toEqual(['ana handed you Task h1', 'ana handed you Task h2'])
  })

  it('Take starts the default agent on it and opens the new worktree', async () => {
    const openWorktree = vi.fn(async () => {})
    useWorkspaceStore.setState({
      openWorktree,
      defaultAgent: 'codex',
      agents: [
        { kind: 'claude', command: 'claude', binary: '/bin/claude' },
        { kind: 'codex', command: 'codex', binary: '/bin/codex' }
      ]
    })
    await useHandoffs.getState().refresh(['p1'])
    const view = render(<HandoffPopups />)

    const first = view.getByText('Task h1').closest('.notice') as HTMLElement
    fireEvent.click(within(first).getByRole('button', { name: 'Take' }))

    await waitFor(() => expect(openWorktree).toHaveBeenCalledWith('wt_taken'))
    expect(call).toHaveBeenCalledWith('teamwork.take', { projectId: 'p1', id: 'h1', agent: 'codex' })
    expect(lines(view)).toEqual(['ana handed you Task h2'])
  })

  it('Dismiss forgets it', async () => {
    await useHandoffs.getState().refresh(['p1'])
    const view = render(<HandoffPopups />)

    const first = view.getByText('Task h1').closest('.notice') as HTMLElement
    fireEvent.click(within(first).getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => expect(lines(view)).toEqual(['ana handed you Task h2']))
    expect(call).toHaveBeenCalledWith('teamwork.dismissHandoff', { projectId: 'p1', id: 'h1' })
  })
})

describe('the sender’s row', () => {
  it('reads “Handed to” until the latest offer is taken, then “Taken by”', () => {
    const mine = offer('h1', { worktreeId: 'wt_a', to: 'bo' })
    expect(handoffLine([mine], 'wt_a')).toBe('Handed to bo')
    expect(handoffLine([{ ...mine, takenAt: 5 }], 'wt_a')).toBe('Taken by bo')
    expect(handoffLine([mine], 'wt_other')).toBeNull()
  })
})
