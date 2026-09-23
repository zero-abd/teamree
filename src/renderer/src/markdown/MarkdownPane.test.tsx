/** @vitest-environment jsdom */

// Opening a page never writes the file; an edit writes only what it changed.

import type { Editor } from '@tiptap/core'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent } from '@shared/entities'
import { AUTOSAVE_DELAY_MS } from './autosave'

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
const { MarkdownPane } = await import('./MarkdownPane')

const INITIAL = useWorkspaceStore.getState()

// Ends on a table, so the editor adds its trailing paragraph the moment it takes focus.
const README = [
  '# Demo service',
  '',
  '- [x] Health endpoint',
  '- [ ] Metrics',
  '- Links like [the docs](https://example.com) stay readable.',
  '',
  'Literal [x] brackets and snake_case stay as written.',
  '',
  '| Route | Status |',
  '|:------|-------:|',
  '| `/health` | 200 |',
  ''
].join('\n')

const read = (content: string): FileContent => ({
  worktreeId: 'w1',
  path: 'README.md',
  content,
  exists: true,
  size: content.length,
  modifiedAt: 100,
  encoding: 'utf-8-bom',
  lineEnding: '\n'
})

// jsdom has no layout; the editor measures text ranges to scroll to the cursor.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const writes = (): unknown[] => call.mock.calls.filter(([method]) => method === 'file.write')

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string) => {
    if (method === 'file.read') return read(README)
    if (method === 'file.write') return { worktreeId: 'w1', path: 'README.md', size: 0, modifiedAt: 200 }
    return undefined
  })
  useWorkspaceStore.setState({ ...INITIAL, unsavedFiles: {} }, true)
})

const mount = () =>
  render(<MarkdownPane paneId="md:1" worktreeId="w1" path="README.md" focused onFocus={() => {}} onClose={() => {}} />)

const page = async (): Promise<Editor> =>
  waitFor(() => {
    const found = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null
    if (!found?.editor) throw new Error('no page yet')
    return found.editor
  })

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS * 2)))

describe('the markdown pane', () => {
  it('opens, takes focus and closes without writing the file', async () => {
    const view = mount()
    const editor = await page()
    act(() => {
      editor.commands.focus('end')
      editor.commands.focus('start')
    })
    await settle()
    view.unmount()
    await settle()
    expect(writes()).toEqual([])
    expect(useWorkspaceStore.getState().unsavedFiles['md:1']).toBeUndefined()
  })

  it('draws task items as checkboxes, beside the plain item in the same list', async () => {
    mount()
    await page()
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.md-editor input[type="checkbox"]')]
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    expect(document.querySelector('.md-editor ul')?.textContent).not.toMatch(/\[[ x]\]/)
  })

  it('writes a checked box as that one line, in the file’s own encoding', async () => {
    mount()
    await page()
    const box = document.querySelectorAll<HTMLInputElement>('.md-editor input[type="checkbox"]')[1]!
    act(() => box.click())
    expect(box.checked).toBe(true)
    await settle()
    expect(writes()).toEqual([
      [
        'file.write',
        {
          worktreeId: 'w1',
          path: 'README.md',
          content: README.replace('- [ ] Metrics', '- [x] Metrics'),
          encoding: 'utf-8-bom'
        }
      ]
    ])
  })
})
