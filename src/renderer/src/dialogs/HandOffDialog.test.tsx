/** @vitest-environment jsdom */

// Hand Off…: roster teammates to choose from, a note prefilled from the runtime's draft,
// and the runtime's refusal said in the dialog.

import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeammatePresence, Worktree } from '@shared/entities'

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
const { HandOffDialog } = await import('./HandOffDialog')

const INITIAL = useWorkspaceStore.getState()

const WORKTREE = {
  id: 'wt_auth',
  projectId: 'p1',
  name: 'Rework auth session',
  branch: 'rework-auth',
  path: '/w/auth',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  task: 'Rework auth session'
} as Worktree

const PRESENCE = {
  state: 'read',
  projectId: 'p1',
  worktrees: [],
  teammates: [
    { handle: 'ana', publicKey: 'ka', connected: false, heardAt: null },
    { handle: 'bo', publicKey: 'kb', connected: true, heardAt: 1 }
  ],
  readAt: 1
} as TeammatePresence

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string) => {
    if (method === 'teamwork.handoffDraft') return { note: 'Rework auth session\n\nDecided:\n- Sessions live in redis' }
    return undefined
  })
  useWorkspaceStore.setState({ ...INITIAL }, true)
  useWorkspaceStore.setState({ worktrees: [WORKTREE], teammates: { p1: PRESENCE } })
})

describe('Hand Off…', () => {
  it('offers the roster, the connected teammate first chosen, and prefills the note', async () => {
    const view = render(<HandOffDialog worktreeId="wt_auth" />)
    expect((view.getByRole('combobox') as HTMLSelectElement).value).toBe('bo')
    const note = view.getByRole('textbox') as HTMLTextAreaElement
    await waitFor(() => expect(note.value).toBe('Rework auth session\n\nDecided:\n- Sessions live in redis'))
    expect(call).toHaveBeenCalledWith('teamwork.handoffDraft', { worktreeId: 'wt_auth' })
  })

  it('sends the chosen teammate and the edited note, and closes', async () => {
    const closeDialog = vi.fn()
    useWorkspaceStore.setState({ closeDialog })
    const view = render(<HandOffDialog worktreeId="wt_auth" />)
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'ana' } })
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Just the tests left.' } })
    fireEvent.click(view.getByRole('button', { name: 'Hand Off' }))

    await waitFor(() => expect(closeDialog).toHaveBeenCalled())
    expect(call).toHaveBeenCalledWith('teamwork.handOff', {
      worktreeId: 'wt_auth',
      to: 'ana',
      note: 'Just the tests left.'
    })
  })

  it('says the refusal and stays open', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'teamwork.handOff') throw new Error('no remote')
      return null
    })
    const closeDialog = vi.fn()
    useWorkspaceStore.setState({ closeDialog })
    const view = render(<HandOffDialog worktreeId="wt_auth" />)
    fireEvent.click(view.getByRole('button', { name: 'Hand Off' }))

    expect((await view.findByRole('alert')).textContent).toBe('no remote')
    expect(closeDialog).not.toHaveBeenCalled()
  })
})
