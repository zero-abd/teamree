/** @vitest-environment jsdom */

// Shared Notes on the Teamwork page: newest first with sender and age, unread counted, View reads it in
// place, Save Copy needs a worktree, and Delete waits out its Undo before the runtime forgets.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedNoteSummary } from '@shared/sharedNote'

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
const { useSharedNotes, unreadNotes } = await import('./sharedNotesStore')
const { SharedNotesList } = await import('./SharedNotesList')
const { UNDO_LIFETIME_MS } = await import('../notices/noticeLifetime')

const INITIAL = useWorkspaceStore.getState()

// jsdom has no layout; the editor measures text ranges to scroll to the cursor.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const NOW = 1_700_000_000_000

const summary = (shareId: string, over: Partial<SharedNoteSummary> = {}): SharedNoteSummary => ({
  shareId,
  projectId: 'p1',
  handle: 'ana',
  publicKey: 'k',
  noteId: 'NOTES.md',
  title: shareId,
  sentAt: 0,
  receivedAt: NOW - 5 * 60_000,
  seen: false,
  bytes: 10,
  ...over
})

let inbox: SharedNoteSummary[]

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  inbox = [
    summary('Old plan', { receivedAt: NOW - 3 * 3_600_000, seen: true, read: true, handle: 'bo' }),
    summary('Search API plan'),
    summary('Elsewhere', { projectId: 'p2' })
  ]
  call.mockReset()
  call.mockImplementation(async (method: string, params: { shareId?: string; path?: string }) => {
    if (method === 'teamwork.sharedNotes') return inbox
    if (method === 'teamwork.viewNote')
      return { ...inbox.find((note) => note.shareId === params.shareId), markdown: '# Hi\n\nbody text' }
    if (method === 'teamwork.closeNote') return { closed: true }
    if (method === 'teamwork.dismissNote') return { dismissed: true }
    if (method === 'file.read') return { exists: false }
    if (method === 'file.write') return {}
    return undefined
  })
  useWorkspaceStore.setState({ ...INITIAL }, true)
  useSharedNotes.setState({ inbox: [], bodies: {}, deleting: {}, expanded: null })
})

afterEach(() => {
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  await act(() => useSharedNotes.getState().refresh())
  render(<SharedNotesList projectId="p1" />)
}

const rows = (): string[] =>
  screen.getAllByRole('listitem').map((row) => row.querySelector('.shared-notes__title')?.textContent ?? '')

describe('Shared Notes on the Teamwork page', () => {
  it('lists this project’s notes newest first, with sender and age, and counts the unread', async () => {
    await mount()
    const list = screen.getByRole('region', { name: 'Shared notes' })
    expect(rows()).toEqual(['Search API plan', 'Old plan'])
    expect(within(list).getByText('1 unread')).toBeTruthy()
    const newest = screen.getAllByRole('listitem')[0] as HTMLElement
    expect(newest.textContent).toContain('ana')
    expect(newest.textContent).toContain('5m ago')
    expect(newest.className).toContain('shared-notes__row--unread')
  })

  it('draws nothing for a project with no notes', async () => {
    await act(() => useSharedNotes.getState().refresh())
    const view = render(<SharedNotesList projectId="p3" />)
    expect(view.container.textContent).toBe('')
  })

  it('View reads the note in place and marks it read', async () => {
    await mount()
    const row = screen.getAllByRole('listitem')[0] as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'View' }))
    await vi.waitFor(() => expect(row.textContent).toContain('body text'))
    expect(call).toHaveBeenCalledWith('teamwork.viewNote', { shareId: 'Search API plan' })
    expect(unreadNotes(useSharedNotes.getState(), 'p1')).toBe(0)
    expect(within(row).getByRole('button', { name: 'Hide' })).toBeTruthy()
  })

  it('Save Copy writes into a worktree of the project, and is off when it has none', async () => {
    await mount()
    const save = within(screen.getAllByRole('listitem')[0] as HTMLElement).getByRole('button', { name: 'Save Copy' })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      useWorkspaceStore.setState({ worktrees: [{ id: 'w1', projectId: 'p1', state: 'ready' } as never] })
    })
    fireEvent.click(save)
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('file.write', expect.objectContaining({ worktreeId: 'w1' }))
    )
  })

  it('Delete hides it at once and offers Undo; the runtime forgets it only when Undo has gone', async () => {
    await mount()
    fireEvent.click(within(screen.getAllByRole('listitem')[0] as HTMLElement).getByRole('button', { name: 'Delete' }))
    expect(rows()).toEqual(['Old plan'])
    const notice = useWorkspaceStore.getState().notices.at(-1)
    expect(notice?.text).toBe('Deleted "Search API plan"')
    expect(notice?.action?.label).toBe('Undo')
    expect(call).not.toHaveBeenCalledWith('teamwork.closeNote', expect.anything())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_LIFETIME_MS)
    })
    expect(call).toHaveBeenCalledWith('teamwork.closeNote', { shareId: 'Search API plan' })
  })

  it('Undo puts the note back and nothing is forgotten', async () => {
    await mount()
    fireEvent.click(within(screen.getAllByRole('listitem')[0] as HTMLElement).getByRole('button', { name: 'Delete' }))
    const action = useWorkspaceStore.getState().notices.at(-1)?.action
    if (action === undefined || !('undo' in action)) throw new Error('no undo')
    await act(() => useWorkspaceStore.getState().undo(action.undo))

    expect(rows()).toEqual(['Search API plan', 'Old plan'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_LIFETIME_MS)
    })
    expect(call).not.toHaveBeenCalledWith('teamwork.closeNote', expect.anything())
  })
})
