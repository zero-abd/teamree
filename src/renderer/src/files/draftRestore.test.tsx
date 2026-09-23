/** @vitest-environment jsdom */

// A SIGTERM or a crash takes the window without asking; the edit it held is in the profile and comes
// back on the next launch, in its pane, still unsaved.

import { render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: async (method: string) =>
      method === 'file.read'
        ? {
            worktreeId: 'w1',
            path: 'src/math.ts',
            content: 'const a = 1\n',
            exists: true,
            size: 12,
            modifiedAt: 100,
            encoding: 'utf-8',
            lineEnding: '\n'
          }
        : undefined,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

// What the last launch wrote before it was killed.
localStorage.setItem(
  'teamree.fileDrafts',
  JSON.stringify({
    'file:1': {
      worktreeId: 'w1',
      path: 'src/math.ts',
      text: 'const a = 2\n',
      savedText: 'const a = 1\n',
      modifiedAt: 100
    }
  })
)

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { FileView } = await import('./FileView')

it('opens the pane with the draft, unsaved, and counts it before the worktree is even opened', async () => {
  expect(useWorkspaceStore.getState().editedFiles).toEqual({ 'file:1': { worktreeId: 'w1', path: 'src/math.ts' } })
  expect(useWorkspaceStore.getState().unsavedFiles).toEqual({ 'file:1': true })

  render(<FileView paneId="file:1" worktreeId="w1" path="src/math.ts" focused onFocus={() => {}} onClose={() => {}} />)
  const content = await waitFor(() => {
    const found = document.querySelector('.cm-content')
    if (!(found instanceof HTMLElement)) throw new Error('no editor yet')
    return found
  })
  expect(EditorView.findFromDOM(content)?.state.doc.toString()).toBe('const a = 2\n')
  expect(document.querySelector('.file__unsaved')).not.toBeNull()
})
