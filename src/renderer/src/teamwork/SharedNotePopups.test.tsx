/** @vitest-environment jsdom */

// The popups a teammate's notes raise: queued oldest first, three at a time, View opens a tab, Close forgets.

import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
const { MAX_NOTE_POPUPS, useSharedNotes } = await import('./sharedNotesStore')
const { SharedNotePopups } = await import('./SharedNotePopups')

const INITIAL = useWorkspaceStore.getState()

const summary = (index: number, over: Partial<SharedNoteSummary> = {}): SharedNoteSummary => ({
  shareId: `s${index}`,
  projectId: 'p1',
  handle: index % 2 === 0 ? 'ana' : 'bo',
  publicKey: 'k',
  noteId: 'NOTES.md',
  title: `Note ${index}`,
  sentAt: index,
  receivedAt: 100 + index,
  seen: false,
  bytes: 10,
  ...over
})

let inbox: SharedNoteSummary[]

beforeEach(() => {
  inbox = [summary(3), summary(1), summary(2), summary(4), summary(0, { seen: true })]
  call.mockReset()
  call.mockImplementation(async (method: string, params: { shareId?: string }) => {
    if (method === 'teamwork.sharedNotes') return inbox
    if (method === 'teamwork.closeNote') {
      inbox = inbox.filter((note) => note.shareId !== params.shareId)
      return { closed: true }
    }
    if (method === 'teamwork.viewNote') {
      const found = inbox.find((note) => note.shareId === params.shareId)
      if (found) found.seen = true
      return { ...found, markdown: '# hi' }
    }
    return undefined
  })
  useWorkspaceStore.setState({ ...INITIAL }, true)
  useSharedNotes.setState({ inbox: [], bodies: {} })
})

const lines = (view: ReturnType<typeof render>): string[] =>
  view
    .queryAllByRole('status')
    .flatMap((region) => [...region.querySelectorAll('.notice__text')].map((line) => line.textContent ?? ''))

describe('a teammate’s shared notes in the corner', () => {
  it('asks about the unseen ones, oldest first, a few at a time', async () => {
    await useSharedNotes.getState().refresh()
    const view = render(<SharedNotePopups />)

    expect(MAX_NOTE_POPUPS).toBe(3)
    expect(lines(view)).toEqual(['bo shared Note 1', 'ana shared Note 2', 'bo shared Note 3'])
  })

  it('Close forgets the note and lets the next one in', async () => {
    await useSharedNotes.getState().refresh()
    const view = render(<SharedNotePopups />)

    const first = view.getByText('Note 1').closest('.notice') as HTMLElement
    fireEvent.click(within(first).getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(lines(view)).toEqual(['ana shared Note 2', 'bo shared Note 3', 'ana shared Note 4']))
    expect(call).toHaveBeenCalledWith('teamwork.closeNote', { shareId: 's1' })
  })

  it('View opens it in a tab and retires the popup without forgetting the note', async () => {
    await useSharedNotes.getState().refresh()
    const openSharedNote = vi.fn(async () => {})
    useWorkspaceStore.setState({ openSharedNote })
    const view = render(<SharedNotePopups />)

    const first = view.getByText('Note 1').closest('.notice') as HTMLElement
    fireEvent.click(within(first).getByRole('button', { name: 'View' }))

    expect(openSharedNote).toHaveBeenCalledWith('p1', 's1', 'Note 1')
    await waitFor(() => expect(lines(view)).toEqual(['ana shared Note 2', 'bo shared Note 3', 'ana shared Note 4']))
    expect(call).toHaveBeenCalledWith('teamwork.viewNote', { shareId: 's1' })
    expect(call).not.toHaveBeenCalledWith('teamwork.closeNote', expect.anything())
    expect(useSharedNotes.getState().bodies.s1?.markdown).toBe('# hi')
  })

  it('shows nothing when nothing is waiting', () => {
    const view = render(<SharedNotePopups />)
    expect(view.queryByRole('status')).toBeNull()
  })

  it('opens a shared note as a read-only tab in a worktree of its project', async () => {
    useWorkspaceStore.setState({
      activeWorktreeId: 'w1',
      worktrees: [{ id: 'w1', projectId: 'p1', state: 'ready' } as never],
      layouts: { w1: { worktreeId: 'w1', root: null, focusedTerminalId: null } }
    })
    await useWorkspaceStore.getState().openSharedNote('p1', 's1', 'Note 1')

    const root = useWorkspaceStore.getState().layouts.w1?.root
    expect(JSON.stringify(root)).toContain('"sharedNote":"s1"')
    expect(JSON.stringify(root)).toContain('"path":"Note 1"')
  })
})
