/** @vitest-environment jsdom */

// Opening a page never writes the file; an edit writes only what it changed.

import type { Editor } from '@tiptap/core'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('taking the focus', () => {
  const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)))
  const pane = (focused: boolean, onFocus: () => void) => (
    <MarkdownPane
      paneId="md:1"
      worktreeId="w1"
      path="README.md"
      focused={focused}
      onFocus={onFocus}
      onClose={() => {}}
    />
  )
  const literal = (): Text =>
    [...document.querySelectorAll('.md-editor p')].find((p) => p.textContent?.startsWith('Literal'))!.firstChild as Text
  // The browser's own part of a click: the page takes the focus with the caret under the pointer.
  // Chrome reports the move after the next frame, where jsdom reports it at once.
  const held = (event: Event): void => event.stopImmediatePropagation()
  const placeCaret = (text: Text, offset: number, editor: Editor): void => {
    window.addEventListener('selectionchange', held, true)
    act(() => {
      editor.view.dom.focus()
      getSelection()!.collapse(text, offset)
    })
    requestAnimationFrame(() => {
      window.removeEventListener('selectionchange', held, true)
      document.dispatchEvent(new Event('selectionchange'))
    })
  }

  afterEach(() => {
    window.removeEventListener('selectionchange', held, true)
    Reflect.deleteProperty(document, 'elementFromPoint')
  })

  it('leaves the caret where a click put it in a page that did not have the focus', async () => {
    let focus = (): void => {}
    const view = render(pane(false, () => focus()))
    focus = () => view.rerender(pane(true, () => {}))
    const editor = await page()
    await frames()
    const text = literal()
    // jsdom has no layout; the page asks what is under the pointer.
    document.elementFromPoint = () => text.parentElement
    fireEvent.mouseDown(text.parentElement!)
    placeCaret(text, 8, editor)
    await frames()
    expect(getSelection()!.anchorNode).toBe(text)
    expect(getSelection()!.anchorOffset).toBe(8)
  })

  it('puts the caret back where it was when the pane gets the focus again', async () => {
    const view = render(pane(true, () => {}))
    const editor = await page()
    await frames()
    const text = literal()
    placeCaret(text, 8, editor)
    await frames()
    const at = editor.state.selection.from
    view.rerender(pane(false, () => {}))
    act(() => editor.view.dom.blur())
    view.rerender(pane(true, () => {}))
    await frames()
    expect(document.activeElement).toBe(editor.view.dom)
    expect(editor.state.selection.from).toBe(at)
    expect(getSelection()!.anchorNode).toBe(text)
    expect(getSelection()!.anchorOffset).toBe(8)
  })
})

describe('images on the page', () => {
  const GUIDE = [
    '# Guide',
    '',
    '![beside](logo.png) ![root](/top.png) ![spaced](my%20shot.png?raw=1)',
    '',
    '![up](../../outside.png) ![dot](data:image/gif;base64,R0lGODlhAQABAAAAACw=)',
    ''
  ].join('\n')
  const IMAGES = ['docs/logo.png', 'top.png', 'docs/my shot.png']

  // Every URL an image in the window was pointed at; a detached document loads nothing.
  const pointedAt: string[] = []
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
  const setAttribute = Element.prototype.setAttribute
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...src,
    set(this: HTMLImageElement, value: string) {
      if (this.ownerDocument === document) pointedAt.push(String(value))
      src.set!.call(this, value)
    }
  })
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (this instanceof HTMLImageElement && name === 'src' && this.ownerDocument === document) pointedAt.push(value)
    setAttribute.call(this, name, value)
  }

  afterAll(() => {
    Object.defineProperty(HTMLImageElement.prototype, 'src', src)
    Element.prototype.setAttribute = setAttribute
  })

  beforeEach(() => {
    pointedAt.length = 0
    call.mockImplementation(async (method: string, params: { path: string; viewer?: boolean }) => {
      if (method === 'file.write') return { worktreeId: 'w1', path: params.path, size: 0, modifiedAt: 200 }
      if (method !== 'file.read') return undefined
      if (params.path === 'docs/guide.md') return { ...read(GUIDE), path: 'docs/guide.md' }
      if (params.viewer === true && IMAGES.includes(params.path))
        return {
          ...read(''),
          path: params.path,
          view: { kind: 'image', mime: 'image/png', url: `teamree-file://grant/${encodeURIComponent(params.path)}` }
        }
      return { ...read(''), path: params.path, exists: false }
    })
  })

  it('loads a relative image from the worktree, and nothing from anywhere else', async () => {
    render(
      <MarkdownPane paneId="md:2" worktreeId="w1" path="docs/guide.md" focused onFocus={() => {}} onClose={() => {}} />
    )
    const editor = await page()
    // Markdown itself refuses a `file:` image; one set by hand is refused here.
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'paragraph',
        content: [{ type: 'image', attrs: { src: 'file:///etc/hosts', alt: 'disk' } }]
      })
    })
    await waitFor(() => expect(document.querySelectorAll('img.md-image[src^="teamree-file:"]')).toHaveLength(3))
    await settle()

    const asked = call.mock.calls.filter(([, params]) => (params as { viewer?: boolean }).viewer === true)
    expect(asked.map(([, params]) => (params as { path: string }).path).sort()).toEqual([...IMAGES].sort())
    expect(pointedAt.filter((url) => !url.startsWith('data:'))).toEqual(
      expect.arrayContaining(IMAGES.map((path) => `teamree-file://grant/${encodeURIComponent(path)}`))
    )
    expect(pointedAt.every((url) => url.startsWith('teamree-file://') || url.startsWith('data:'))).toBe(true)
    const byAlt = (alt: string) => document.querySelector(`img.md-image[alt="${alt}"]`)
    expect(byAlt('up')?.hasAttribute('src')).toBe(false)
    expect(byAlt('disk')?.hasAttribute('src')).toBe(false)
    expect(byAlt('dot')?.getAttribute('src')).toMatch(/^data:image\/gif/)
  })
})
