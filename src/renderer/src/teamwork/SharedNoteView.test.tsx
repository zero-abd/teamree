/** @vitest-environment jsdom */

// A received note is somebody else's text: drawn, never run, and nothing in it is fetched.

import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedNote } from '@shared/sharedNote'

const call = vi.fn()
const opened = vi.fn()

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
vi.mock('../shell/openInBrowser', () => ({ openInBrowser: (url: string) => opened(url) }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useSharedNotes } = await import('./sharedNotesStore')
const { SharedNoteView } = await import('./SharedNoteView')

const INITIAL = useWorkspaceStore.getState()

// jsdom has no layout; the editor measures text ranges to scroll to the cursor.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const HOSTILE = [
  '# Plan',
  '',
  '<script>window.__pwned = "block"</script>',
  '',
  'Inline <img src="x" onerror="window.__pwned = \'inline\'"> here.',
  '',
  '![tracker](https://tracker.invalid/pixel.png)',
  '',
  '![local](../../secret.png)',
  '',
  '[run me](javascript:window.__pwned=%22link%22) and [docs](https://example.com/docs)',
  ''
].join('\n')

const note = (markdown: string): SharedNote => ({
  shareId: 's1',
  projectId: 'p1',
  handle: 'ana',
  publicKey: 'k',
  noteId: 'NOTES.md',
  title: 'Plan',
  sentAt: 1,
  receivedAt: 2,
  seen: false,
  bytes: markdown.length,
  markdown
})

let files: Record<string, string>

beforeEach(() => {
  files = { 'Plan.md': 'mine' }
  call.mockReset()
  opened.mockReset()
  call.mockImplementation(async (method: string, params: { path?: string; content?: string }) => {
    if (method === 'teamwork.viewNote') return note(HOSTILE)
    if (method === 'file.read') {
      const content = files[params.path ?? '']
      return {
        worktreeId: 'w1',
        path: params.path,
        content: content ?? '',
        exists: content !== undefined,
        size: 0,
        modifiedAt: 1
      }
    }
    if (method === 'file.write') {
      files[params.path ?? ''] = params.content ?? ''
      return { worktreeId: 'w1', path: params.path, size: 0, modifiedAt: 2 }
    }
    return undefined
  })
  useWorkspaceStore.setState({ ...INITIAL, notices: [] }, true)
  useSharedNotes.setState({ inbox: [], bodies: {} })
  delete (window as { __pwned?: string }).__pwned
})

afterEach(() => {
  delete (window as { __pwned?: string }).__pwned
})

const mount = () =>
  render(
    <SharedNoteView
      shareId="s1"
      paneId="file:n"
      worktreeId="w1"
      path="Plan"
      focused
      onFocus={() => {}}
      onClose={() => {}}
    />
  )

const page = (): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector('.ProseMirror') as HTMLElement | null
    if (!found) throw new Error('no page yet')
    return found
  })

describe('a received note on screen', () => {
  it('runs nothing in it and shows raw HTML as text', async () => {
    mount()
    const shown = await page()

    expect(shown.querySelector('script')).toBeNull()
    expect(shown.querySelector('[onerror]')).toBeNull()
    expect(shown.textContent).toContain('<script>window.__pwned = "block"</script>')
    expect(shown.textContent).toContain('<img src="x"')
    expect((window as { __pwned?: string }).__pwned).toBeUndefined()
  })

  it('loads no image, remote or local', async () => {
    mount()
    const shown = await page()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const images = [...shown.querySelectorAll('img')]
    expect(images.length).toBeGreaterThan(0)
    expect(images.every((image) => !image.hasAttribute('src') || image.getAttribute('src') === '')).toBe(true)
  })

  it('carries no script link, and opens nothing by itself', async () => {
    mount()
    const shown = await page()

    expect(shown.querySelector('a[href^="javascript:"]')).toBeNull()
    const docs = [...shown.querySelectorAll('a')].find((anchor) => anchor.textContent === 'docs')
    expect(docs?.getAttribute('href')).toBe('https://example.com/docs')
    expect(opened).not.toHaveBeenCalled()
  })

  it('cannot be edited', async () => {
    mount()
    const shown = await page()
    expect(shown.getAttribute('contenteditable')).toBe('false')
    expect(document.querySelector('.md-handle, .md-format')).toBeNull()
  })

  it('Save Copy writes it under a free name in this worktree and opens it', async () => {
    const view = mount()
    await page()
    const openFilePane = vi.fn()
    useWorkspaceStore.setState({ openFilePane })

    fireEvent.click(view.getByRole('button', { name: 'Save Copy' }))

    await waitFor(() => expect(files['Plan 2.md']).toBe(HOSTILE))
    expect(files['Plan.md']).toBe('mine')
    expect(openFilePane).toHaveBeenCalledWith('w1', 'Plan 2.md')
    expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toEqual(['Saved Plan 2.md'])
  })

  it('says Gone for a note the runtime no longer has', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'teamwork.viewNote') throw new Error('that note is gone')
      return undefined
    })
    const view = mount()
    await waitFor(() => expect(view.getByText('Gone')).toBeTruthy())
    expect(view.queryByRole('button', { name: 'Save Copy' })).toBeNull()
  })
})
