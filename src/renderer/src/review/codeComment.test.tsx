/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { beforeEach, expect, it, vi } from 'vitest'
import type { FileContent } from '@shared/entities'

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
const { FileView } = await import('../files/FileView')

const INITIAL = useWorkspaceStore.getState()

const BODY = 'const a = 1\nconst b = 2\nconst c = 3\n'
const content: FileContent = {
  worktreeId: 'w1',
  path: 'src/math.ts',
  content: BODY,
  exists: true,
  size: BODY.length,
  modifiedAt: 100,
  encoding: 'utf-8',
  lineEnding: '\n'
}

Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string) => (method === 'file.read' ? content : undefined))
  useWorkspaceStore.setState({ ...INITIAL, activeWorktreeId: 'w1' }, true)
})

it('opens a comment on the selected code lines from the gutter’s +', async () => {
  render(<FileView paneId="file:1" worktreeId="w1" path="src/math.ts" focused onFocus={() => {}} onClose={() => {}} />)
  const plus = await waitFor(
    () => {
      const found = document.querySelector('.cm-commentGutter .cm-gutterElement:not([style*="hidden"])')
      if (!(found instanceof HTMLElement)) throw new Error('no gutter yet')
      return found
    },
    { timeout: 5_000 }
  )
  const view = EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!
  view.dispatch({ selection: { anchor: 0, head: 15 } })
  fireEvent.mouseDown(plus)
  expect(screen.getByRole('group', { name: 'Comment on src/math.ts:1-2' })).toBeTruthy()
})
