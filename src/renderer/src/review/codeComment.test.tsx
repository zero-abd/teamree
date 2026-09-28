/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const { useReviewStore } = await import('./reviewStore')

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

// As the diff's rows (#553): a line a batched comment quotes keeps a dot in the gutter until the batch goes.
it('marks the code lines a batched comment quotes, until the batch is cleared', async () => {
  useReviewStore.getState().clearBatch('w1')
  useReviewStore.getState().addToBatch('w1', {
    path: 'src/math.ts',
    lines: [{ kind: 'context', text: 'const b = 2', oldNumber: null, newNumber: 2 }],
    note: 'Name this.'
  })
  // A diff's context line with the same new number is a comment on the diff, not on this view.
  useReviewStore.getState().addToBatch('w1', {
    path: 'src/math.ts',
    lines: [{ kind: 'context', text: 'const c = 3', oldNumber: 3, newNumber: 3 }],
    note: 'x'
  })
  render(<FileView paneId="file:1" worktreeId="w1" path="src/math.ts" focused onFocus={() => {}} onClose={() => {}} />)
  const marks = (): Element[] => [...document.querySelectorAll('[aria-label="Comment in batch"]')]
  await waitFor(() => expect(marks()).toHaveLength(1), { timeout: 5_000 })
  // The gutters run side by side, one element per line: the mark sits in line 2's row.
  const row = marks()[0]?.closest('.cm-gutterElement') as Element
  const at = [...(row.parentElement?.children ?? [])].indexOf(row)
  expect(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')[at]?.textContent).toBe('2')
  act(() => useReviewStore.getState().clearBatch('w1'))
  expect(marks()).toHaveLength(0)
})
