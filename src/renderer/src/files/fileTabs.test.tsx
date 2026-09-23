/** @vitest-environment jsdom */

// A file tab is a leaf of the tree: opened beside the focused pane, closed by
// rewriting the tree, and held open by a question while it has unsaved edits.
// The viewer under it reads, edits and saves through the runtime.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent, FileView as FileViewAnswer, Layout } from '@shared/entities'
import { fileLeavesIn } from '@shared/filePane'

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
const { FileView } = await import('./FileView')
const { paneTabs } = await import('../workspace/paneTabs')

const INITIAL = useWorkspaceStore.getState()

const terminalOnly: Layout = { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' }

const text = (body: string, modifiedAt = 100): FileContent => ({
  worktreeId: 'w1',
  path: 'src/app.ts',
  content: body,
  exists: true,
  size: body.length,
  modifiedAt,
  encoding: 'utf-8',
  lineEnding: '\n'
})

// jsdom has no layout; CodeMirror measures text ranges.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string, params: { root?: unknown }) => {
    if (method === 'layout.set') return params
    return undefined
  })
  useWorkspaceStore.setState(
    { ...INITIAL, activeWorktreeId: 'w1', layouts: { w1: terminalOnly }, unsavedFiles: {} },
    true
  )
})

const layout = (): Layout => useWorkspaceStore.getState().layouts.w1!

describe('file tabs in the store', () => {
  it('opens beside the focused pane, focuses it, and reuses the tab for the same path', () => {
    useWorkspaceStore.getState().openFilePane('w1', 'src/app.ts')
    const [leaf] = fileLeavesIn(layout().root)
    expect(leaf?.path).toBe('src/app.ts')
    expect(layout().focusedTerminalId).toBe(leaf?.terminalId)
    expect(paneTabs(layout().root, {}).map((tab) => [tab.label, tab.kind])).toEqual([
      ['terminal', undefined],
      ['app.ts', 'file']
    ])

    useWorkspaceStore.getState().focusPane('t1')
    useWorkspaceStore.getState().openFilePane('w1', 'src/app.ts')
    expect(fileLeavesIn(layout().root)).toHaveLength(1)
    expect(layout().focusedTerminalId).toBe(leaf?.terminalId)
    expect(call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(0)
  })

  it('stacks further files in the column the first one opened, leaving the terminal its width', () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.ts')
    useWorkspaceStore.getState().focusPane('t1')
    useWorkspaceStore.getState().openFilePane('w1', 'b.png')
    const root = layout().root
    expect(root?.kind === 'split' && root.direction).toBe('row')
    if (root?.kind !== 'split') return
    expect(root.children[0]).toEqual({ kind: 'leaf', terminalId: 't1' })
    const column = root.children[1]
    expect(column?.kind === 'split' && column.direction).toBe('column')
    expect(fileLeavesIn(column ?? null).map((leaf) => leaf.path)).toEqual(['a.ts', 'b.png'])
  })

  it('closes a clean tab by rewriting the tree, never by ending a terminal', async () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.png')
    const id = fileLeavesIn(layout().root)[0]!.terminalId
    await useWorkspaceStore.getState().closeTerminal(id)
    expect(fileLeavesIn(layout().root)).toEqual([])
    expect(layout().focusedTerminalId).toBe('t1')
    expect(call).not.toHaveBeenCalledWith('terminal.close', expect.anything())
  })

  it('asks before closing a tab with unsaved edits, and forgets the dot once closed', async () => {
    useWorkspaceStore.getState().openFilePane('w1', 'src/app.ts')
    const id = fileLeavesIn(layout().root)[0]!.terminalId
    useWorkspaceStore.getState().setFileUnsaved(id, true)
    await useWorkspaceStore.getState().closeTerminal(id)
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-close-file', terminalId: id })
    expect(fileLeavesIn(layout().root)).toHaveLength(1)

    await useWorkspaceStore.getState().forceCloseTerminal(id)
    expect(fileLeavesIn(layout().root)).toEqual([])
    expect(useWorkspaceStore.getState().unsavedFiles).toEqual({})
  })
})

describe('the file viewer', () => {
  const mount = (path = 'src/app.ts') =>
    render(<FileView paneId="file:1" worktreeId="w1" path={path} focused onFocus={() => {}} onClose={() => {}} />)

  const editorView = async (): Promise<EditorView> => {
    const content = await waitFor(() => {
      const found = document.querySelector('.cm-content')
      if (!(found instanceof HTMLElement)) throw new Error('no editor yet')
      return found
    })
    return EditorView.findFromDOM(content)!
  }

  it('edits, marks the tab unsaved, and saves on ⌘S against the version it read', async () => {
    let onDisk = text('const a = 1\n')
    call.mockImplementation(async (method: string, params: { content?: string }) => {
      if (method === 'file.read') return onDisk
      if (method === 'file.write') {
        onDisk = text(params.content ?? '', 200)
        return { worktreeId: 'w1', path: 'src/app.ts', size: onDisk.size, modifiedAt: 200 }
      }
      return undefined
    })
    mount()
    const view = await editorView()
    expect(view.state.doc.toString()).toBe('const a = 1\n')

    act(() => view.dispatch({ changes: { from: 10, to: 11, insert: '2' } }))
    expect(useWorkspaceStore.getState().unsavedFiles['file:1']).toBe(true)

    fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })
    await waitFor(() => expect(useWorkspaceStore.getState().unsavedFiles['file:1']).toBeUndefined())
    expect(call).toHaveBeenCalledWith('file.write', {
      worktreeId: 'w1',
      path: 'src/app.ts',
      content: 'const a = 2\n',
      encoding: 'utf-8',
      expectedModifiedAt: 100
    })
    expect(onDisk).toMatchObject({ content: 'const a = 2\n' })
  })

  it('offers Reload and Overwrite when the file changed under the edit', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'file.read') return text('x\n')
      if (method === 'file.write') throw Object.assign(new Error('changed on disk'), { code: 'conflict' })
      return undefined
    })
    mount()
    const view = await editorView()
    act(() => view.dispatch({ changes: { from: 0, insert: 'y' } }))
    fireEvent.keyDown(view.contentDOM, { key: 's', ctrlKey: true })
    expect(await screen.findByRole('button', { name: 'Overwrite' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('draws an image, a PDF, media and a binary file by what the runtime answered', async () => {
    const answers: Record<string, FileViewAnswer> = {
      'a.png': { kind: 'image', url: 'teamree-file://grant/1/a.png', mime: 'image/png' },
      'a.pdf': { kind: 'pdf', url: 'teamree-file://grant/2/a.pdf', mime: 'application/pdf' },
      'a.mp4': { kind: 'media', url: 'teamree-file://grant/3/a.mp4', mime: 'video/mp4' },
      'a.bin': { kind: 'binary' },
      'big.log': { kind: 'tooLarge', limit: 10 }
    }
    call.mockImplementation(async (method: string, params: { path: string; viewer?: boolean }) =>
      method === 'file.read' && params.viewer
        ? {
            worktreeId: 'w1',
            path: params.path,
            content: '',
            exists: true,
            size: 2048,
            modifiedAt: 1,
            view: answers[params.path]
          }
        : undefined
    )
    let view = mount('a.png')
    expect((await screen.findByRole('img', { name: 'a.png' })).getAttribute('src')).toBe('teamree-file://grant/1/a.png')
    view.unmount()
    view = mount('a.pdf')
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe('teamree-file://grant/2/a.pdf')
    )
    view.unmount()
    view = mount('a.mp4')
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('teamree-file://grant/3/a.mp4')
    )
    view.unmount()
    view = mount('a.bin')
    expect(await screen.findByText('Binary · 2.0 KB')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open in default app' })).toBeTruthy()
    view.unmount()
    mount('big.log')
    expect(await screen.findByText('Too large · 2.0 KB')).toBeTruthy()
  })

  it('shows the working-tree diff for the file on Diff', async () => {
    call.mockImplementation(async (method: string, params: { staged?: boolean }) => {
      if (method === 'file.read') return text('a\n')
      if (method === 'worktree.diff') {
        return {
          worktreeId: 'w1',
          path: 'src/app.ts',
          staged: params.staged ?? false,
          patch: params.staged
            ? ''
            : 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-b\n+a\n',
          truncated: false,
          readAt: 1
        }
      }
      return undefined
    })
    mount()
    await editorView()
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.diff', { worktreeId: 'w1', path: 'src/app.ts' }))
    await waitFor(() => expect(document.querySelector('.patch')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true')
  })
})
