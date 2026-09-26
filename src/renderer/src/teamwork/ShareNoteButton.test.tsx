/** @vitest-environment jsdom */

// Share on a markdown pane: dimmed with a reason when nobody can receive it, a one-line confirm naming
// who will, and what leaves this machine.

import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeammateStanding, TeamworkStatus } from '@shared/entities'
import { MAX_SHARED_NOTE_BYTES, NOTE_TOO_LARGE } from '@shared/sharedNote'

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
const { ShareNoteButton, shareOutcome } = await import('./ShareNoteButton')

const INITIAL = useWorkspaceStore.getState()

const status = (disabledReason: string | null): TeamworkStatus => ({
  state: 'read',
  projectId: 'p1',
  relay: { url: 'wss://relay.invalid', source: 'repository' },
  disabledReason,
  origin: { ok: true, url: 'git@example.invalid:t/r.git' },
  enrolled: true,
  links: [],
  readAt: 0
})

const mate = (handle: string, connected: boolean): TeammateStanding => ({
  handle,
  publicKey: `key-${handle}`,
  connected,
  heardAt: null
})

function team(disabledReason: string | null, teammates: TeammateStanding[]): void {
  useWorkspaceStore.setState({
    worktrees: [{ id: 'w1', projectId: 'p1', state: 'ready' } as never],
    teamwork: { p1: status(disabledReason) },
    teammates: { p1: { state: 'read', projectId: 'p1', worktrees: [], teammates, readAt: 0 } }
  })
}

let markdown = '# Plan\n\n![flow](flow.png)\n'
const mount = () => render(<ShareNoteButton worktreeId="w1" path="NOTES.md" getMarkdown={() => markdown} />)
const notices = (): string[] => useWorkspaceStore.getState().notices.map((notice) => notice.text)

beforeEach(() => {
  markdown = '# Plan\n\n![flow](flow.png)\n'
  call.mockReset()
  call.mockImplementation(async (method: string) =>
    method === 'teamwork.shareNote'
      ? { projectId: 'p1', delivered: ['ana'], missed: [{ handle: 'bo', reason: 'offline' }] }
      : undefined
  )
  useWorkspaceStore.setState({ ...INITIAL, notices: [] }, true)
})

describe('Share on a note', () => {
  it.each([
    ['Teamwork off', 'no relay', [mate('ana', true)]],
    ['No teammates', null, []],
    ['No teammates online', null, [mate('ana', false)]]
  ] as const)('is dimmed with “%s”', (reason, disabled, mates) => {
    team(disabled, [...mates])
    const button = mount().getByRole('button', { name: 'Share' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toBe(reason)
  })

  it('is dimmed when the project has not been read', () => {
    const button = mount().getByRole('button', { name: 'Share' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('confirms in one line who gets it, who is offline, and what is left out', () => {
    team(null, [mate('ana', true), mate('bo', false)])
    const view = mount()
    fireEvent.click(view.getByRole('button', { name: 'Share' }))

    expect(view.getByRole('group', { name: 'Share note' }).textContent).toBe(
      'Share with ana? · bo offline · 1 image left outShareCancel'
    )
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(call).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'Share' })).toBeTruthy()
  })

  it('sends the page with its local images left out, and says who got it', async () => {
    team(null, [mate('ana', true), mate('bo', false)])
    const view = mount()
    fireEvent.click(view.getByRole('button', { name: 'Share' }))
    fireEvent.click(view.getByRole('button', { name: 'Share' }))

    await waitFor(() => expect(notices()).toEqual(['Shared with ana · bo offline']))
    expect(call).toHaveBeenCalledWith('teamwork.shareNote', {
      projectId: 'p1',
      noteId: 'NOTES.md',
      title: 'Plan',
      markdown: '# Plan\n\n\\[image: flow\\]\n'
    })
  })

  it('refuses a note over the cap without asking the runtime', () => {
    team(null, [mate('ana', true)])
    markdown = 'x'.repeat(MAX_SHARED_NOTE_BYTES + 1)
    const view = mount()
    fireEvent.click(view.getByRole('button', { name: 'Share' }))

    expect(notices()).toEqual([NOTE_TOO_LARGE])
    expect(view.queryByRole('group', { name: 'Share note' })).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('words an outcome nobody received as a failure', () => {
    expect(shareOutcome({ projectId: 'p1', delivered: [], missed: [{ handle: 'bo', reason: 'offline' }] })).toBe(
      'Not shared · bo offline'
    )
    expect(shareOutcome({ projectId: 'p1', delivered: ['ana', 'bo'], missed: [] })).toBe('Shared with ana, bo')
  })
})
