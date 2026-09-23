/** @vitest-environment jsdom */

// Nothing edited is lost without a question: closing a pane, quitting, or closing the window asks
// Save, Don't Save or Cancel, and the edits sit in the profile until one of them is answered.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent, Layout } from '@shared/entities'
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
const { ConfirmCloseFileDialog } = await import('../dialogs/ConfirmCloseFileDialog')
const { ConfirmUnsavedDialog } = await import('../dialogs/ConfirmUnsavedDialog')
const { draftFor, dropDraft, keepDraft, keptDrafts } = await import('./fileDrafts')
const { runWorkspaceCommand } = await import('../keyboard/workspaceCommands')

const INITIAL = useWorkspaceStore.getState()

const terminalOnly: Layout = { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' }

const text = (body: string, modifiedAt = 100): FileContent => ({
  worktreeId: 'w1',
  path: 'src/math.ts',
  content: body,
  exists: true,
  size: body.length,
  modifiedAt,
  encoding: 'utf-8',
  lineEnding: '\n'
})

Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const writes = (): unknown[] =>
  call.mock.calls.filter(([method]) => method === 'file.write').map(([, params]) => params)

beforeEach(() => {
  for (const paneId of [...keptDrafts().keys()]) dropDraft(paneId)
  call.mockReset()
  call.mockImplementation(async (method: string, params: { root?: unknown; content?: string }) => {
    if (method === 'layout.set') return params
    if (method === 'file.read') return text('const a = 1\n')
    if (method === 'file.write') return { worktreeId: 'w1', path: 'src/math.ts', size: 1, modifiedAt: 200 }
    return undefined
  })
  useWorkspaceStore.setState(
    { ...INITIAL, activeWorktreeId: 'w1', layouts: { w1: terminalOnly }, unsavedFiles: {}, editedFiles: {} },
    true
  )
})

const store = () => useWorkspaceStore.getState()
const layout = (): Layout => store().layouts.w1!

/** A file pane whose editor is not mounted, holding an edit as a kept draft. */
function editedPane(): string {
  store().openFilePane('w1', 'src/math.ts')
  const id = fileLeavesIn(layout().root)[0]!.terminalId
  keepDraft(id, {
    worktreeId: 'w1',
    path: 'src/math.ts',
    text: 'const a = 2\n',
    savedText: 'const a = 1\n',
    modifiedAt: 100
  })
  store().setFileEdited(id, { worktreeId: 'w1', path: 'src/math.ts' })
  return id
}

describe('closing a pane with edits', () => {
  it('asks Save, Don’t Save or Cancel, with Save the default', async () => {
    const id = editedPane()
    await store().closeTerminal(id)
    expect(store().dialog).toEqual({ kind: 'confirm-close-file', terminalId: id })
    render(<ConfirmCloseFileDialog terminalId={id} />)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.modal__actions .button')]
    expect(buttons.map((button) => button.textContent)).toEqual(["Don't Save", 'Cancel', 'Save'])
    expect(buttons[2]?.dataset.default).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Save changes to math.ts?' })).toBeTruthy()
  })

  it('writes the edit and closes on Save', async () => {
    const id = editedPane()
    await store().closeTerminal(id)
    render(<ConfirmCloseFileDialog terminalId={id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fileLeavesIn(layout().root)).toEqual([]))
    expect(writes()).toEqual([
      { worktreeId: 'w1', path: 'src/math.ts', content: 'const a = 2\n', encoding: 'utf-8', expectedModifiedAt: 100 }
    ])
    expect(store().editedFiles).toEqual({})
    expect(draftFor(id, 'w1', 'src/math.ts')).toBeUndefined()
  })

  it('closes without writing on Don’t Save, and forgets the draft', async () => {
    const id = editedPane()
    await store().closeTerminal(id)
    render(<ConfirmCloseFileDialog terminalId={id} />)
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }))
    await waitFor(() => expect(fileLeavesIn(layout().root)).toEqual([]))
    expect(writes()).toEqual([])
    expect(draftFor(id, 'w1', 'src/math.ts')).toBeUndefined()
  })

  it('keeps the pane and its edit on Cancel', async () => {
    const id = editedPane()
    await store().closeTerminal(id)
    render(<ConfirmCloseFileDialog terminalId={id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(store().dialog).toBeNull())
    expect(fileLeavesIn(layout().root)).toHaveLength(1)
    expect(store().editedFiles[id]).toBeDefined()
    expect(draftFor(id, 'w1', 'src/math.ts')?.text).toBe('const a = 2\n')
  })

  it('asks before removing a worktree that holds one', async () => {
    const id = editedPane()
    await store().removeWorktree('w1')
    expect(store().dialog).toEqual({ kind: 'confirm-unsaved', paneIds: [id], after: { remove: 'w1' } })
    expect(call).not.toHaveBeenCalledWith('worktree.remove', expect.anything())
  })
})

describe('quitting with edits', () => {
  const editorView = async (): Promise<EditorView> => {
    const content = await waitFor(
      () => {
        const found = document.querySelector('.cm-content')
        if (!(found instanceof HTMLElement)) throw new Error('no editor yet')
        return found
      },
      { timeout: 5_000 }
    )
    return EditorView.findFromDOM(content)!
  }

  /** A mounted editor with one edit typed into it. */
  async function typedPane(): Promise<string> {
    store().openFilePane('w1', 'src/math.ts')
    const id = fileLeavesIn(layout().root)[0]!.terminalId
    render(<FileView paneId={id} worktreeId="w1" path="src/math.ts" focused onFocus={() => {}} onClose={() => {}} />)
    const view = await editorView()
    act(() => view.dispatch({ changes: { from: 10, to: 11, insert: '3' } }))
    expect(store().editedFiles[id]).toEqual({ worktreeId: 'w1', path: 'src/math.ts' })
    return id
  }

  it('writes nothing on Save or Save All when nothing was edited, or the edit was undone', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'file.read') return { ...text('a\r\nb\nc\r\n'), lineEnding: '\r\n' }
      return undefined
    })
    store().openFilePane('w1', 'src/math.ts')
    const id = fileLeavesIn(layout().root)[0]!.terminalId
    render(<FileView paneId={id} worktreeId="w1" path="src/math.ts" focused onFocus={() => {}} onClose={() => {}} />)
    const view = await editorView()
    runWorkspaceCommand('save-file', store())
    runWorkspaceCommand('save-all', store())
    expect(await store().saveFiles([id])).toBe(true)
    act(() => view.dispatch({ changes: { from: 0, to: 1, insert: 'x' } }))
    act(() => view.dispatch({ changes: { from: 0, to: 1, insert: 'a' } }))
    expect(await store().saveFiles([id])).toBe(true)
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(writes()).toEqual([])
  })

  it('lets a quit through at once with nothing edited', async () => {
    expect(await store().askBeforeLeaving('quit')).toBe(true)
    expect(store().dialog).toBeNull()
  })

  it('asks once, listing the files, and Cancel keeps the app and the edits', async () => {
    const id = await typedPane()
    const answer = store().askBeforeLeaving('quit')
    const dialog = store().dialog
    expect(dialog).toEqual({ kind: 'confirm-unsaved', paneIds: [id], after: 'quit' })
    if (dialog?.kind !== 'confirm-unsaved') return
    render(<ConfirmUnsavedDialog paneIds={dialog.paneIds} after={dialog.after} />)
    expect(screen.getByText('src/math.ts', { selector: 'li' })).toBeTruthy()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .modal__actions .button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Discard', 'Cancel', 'Save All'])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await answer).toBe(false)
    expect(writes()).toEqual([])
    expect(store().editedFiles[id]).toBeDefined()
    expect(draftFor(id, 'w1', 'src/math.ts')?.text).toBe('const a = 3\n')
  })

  it('writes what the editor holds on Save All, then lets the quit go', async () => {
    const id = await typedPane()
    const answer = store().askBeforeLeaving('quit')
    const dialog = store().dialog
    if (dialog?.kind !== 'confirm-unsaved') throw new Error('no question')
    render(<ConfirmUnsavedDialog paneIds={dialog.paneIds} after={dialog.after} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save All' }))
    expect(await answer).toBe(true)
    expect(writes()).toEqual([
      { worktreeId: 'w1', path: 'src/math.ts', content: 'const a = 3\n', encoding: 'utf-8', expectedModifiedAt: 100 }
    ])
    expect(store().editedFiles).toEqual({})
    expect(draftFor(id, 'w1', 'src/math.ts')).toBeUndefined()
  })

  it('keeps the app when a save fails', async () => {
    await typedPane()
    call.mockImplementation(async (method: string) => {
      if (method === 'file.write') throw Object.assign(new Error('changed on disk'), { code: 'conflict' })
      return method === 'file.read' ? text('const a = 1\n') : undefined
    })
    const answer = store().askBeforeLeaving('quit')
    await store().answerUnsaved('save')
    expect(await answer).toBe(false)
  })

  it('never leaves the main process waiting when the question is dismissed another way', async () => {
    await typedPane()
    const answer = store().askBeforeLeaving('close')
    store().openDialog({ kind: 'palette' })
    expect(await answer).toBe(false)
  })
})
