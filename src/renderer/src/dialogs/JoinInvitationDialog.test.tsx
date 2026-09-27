/** @vitest-environment jsdom */

// Join a Team…: the one field an invitation is pasted into, from anywhere, with or without a project.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatInvitation } from '@shared/invitation'

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
const { JoinInvitationDialog } = await import('./JoinInvitationDialog')

const INITIAL = useWorkspaceStore.getState()
const INVITATION = { origin: 'git@github.com:ana/ledger.git', project: 'ledger', from: 'ana' }

beforeEach(() => {
  useWorkspaceStore.setState({ ...INITIAL, projects: [], dialog: { kind: 'join-invitation' } }, true)
  render(<JoinInvitationDialog />)
})

const field = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Invitation' }) as HTMLInputElement

describe('Join a Team…', () => {
  it('opens the Join sheet as soon as either form of the link is pasted', () => {
    fireEvent.change(field(), { target: { value: `come join ${formatInvitation(INVITATION, 'page')}` } })
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'join-team', invitation: INVITATION })
  })

  it('takes the app link too, from Join', () => {
    fireEvent.change(field(), { target: { value: formatInvitation(INVITATION) } })
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'join-team', invitation: INVITATION })
  })

  it('says why not only when Join is pressed on something that is not an invitation', () => {
    fireEvent.change(field(), { target: { value: 'see you tomorrow' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(screen.getByRole('alert').textContent).toMatch(/^Not an invitation: /)
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'join-invitation' })
  })

  it('has nothing to join while the field is empty', () => {
    expect((screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
