/** @vitest-environment jsdom */

// The Join sheet: where the checkout goes, or the one already here, and one button.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamworkStatus } from '@shared/entities'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()

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
const { JoinTeamDialog } = await import('./JoinTeamDialog')

const INITIAL = useWorkspaceStore.getState()
const joinTeam = vi.fn()
const INVITATION = { origin: 'git@github.com:acme/pantry.git', project: 'pantry', from: 'ana' }

const read = (origin: string): TeamworkStatus => ({
  state: 'read',
  projectId: 'p1',
  relay: null,
  disabledReason: null,
  origin: { ok: true, url: origin },
  enrolled: false,
  links: [],
  readAt: 0
})

function seed(originHere: string): void {
  call.mockImplementation(async (method) => {
    if (method === 'teamwork.status') return read(originHere)
    throw new Error(`unexpected ${method}`)
  })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'larder', path: '/repos/larder', baseRef: 'origin/main' }],
      joinTeam
    },
    true
  )
}

beforeEach(() => {
  joinTeam.mockReset()
  call.mockReset()
})

describe('the Join sheet', () => {
  it('names the project and who sent it, and clones into the destination shown', async () => {
    seed('git@github.com:acme/other.git')
    render(<JoinTeamDialog invitation={INVITATION} />)
    expect(screen.getByRole('heading', { name: 'Join pantry (from ana)' })).toBeTruthy()
    const destination = screen.getByLabelText('Destination') as HTMLInputElement
    expect(destination.value).toMatch(/code\/pantry$/)
    expect(screen.getByRole('button', { name: 'Choose…' })).toBeTruthy()
    await waitFor(() => expect(call).toHaveBeenCalledWith('teamwork.status', { projectId: 'p1' }))
    expect(screen.queryByRole('button', { name: 'Use Existing Checkout' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(joinTeam).toHaveBeenCalledWith(INVITATION, { clone: destination.value })
  })

  it('uses the checkout already here when a project has the same origin', async () => {
    seed('ssh://git@github.com/acme/pantry')
    render(<JoinTeamDialog invitation={INVITATION} />)
    await screen.findByText('/repos/larder')
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(joinTeam).toHaveBeenCalledWith(INVITATION, { projectId: 'p1' })

    fireEvent.click(screen.getByRole('button', { name: 'Clone Again…' }))
    expect(screen.getByRole('button', { name: 'Use Existing Checkout' })).toBeTruthy()
  })

  it('keeps a failure before there is a project in the sheet, in one line', () => {
    seed('git@github.com:acme/other.git')
    useWorkspaceStore.setState({ joining: { stage: 'clone', error: 'Repository not found' } })
    render(<JoinTeamDialog invitation={INVITATION} />)
    expect(screen.getByRole('alert').textContent).toBe('Repository not found')
    expect((screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
