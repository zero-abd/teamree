/** @vitest-environment jsdom */

// The page's own controls: the `/` menu, the bar over a selection, and the handle beside a block.

import type { Editor } from '@tiptap/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor'
import { SLASH_GROUPS } from './slashCommands'

// jsdom has no layout; the editor measures text ranges to place its menus.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const onChange = vi.fn()

beforeEach(() => onChange.mockReset())
afterEach(() => document.body.replaceChildren())

function mount(initial: string) {
  return render(
    <MarkdownEditor
      initial={initial}
      onChange={onChange}
      onFocusChange={() => {}}
      onOpenUrl={() => {}}
      resolveImage={() => null}
    />
  )
}

const page = async (): Promise<Editor> =>
  waitFor(() => {
    const found = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null
    if (!found?.editor) throw new Error('no page yet')
    return found.editor
  })

const lastWrite = (): string => onChange.mock.calls.at(-1)?.[0] as string
const key = (editor: Editor, name: string) => fireEvent.keyDown(editor.view.dom, { key: name })

describe('the / menu', () => {
  it('opens grouped, walks with the arrows and inserts with Enter', async () => {
    mount('')
    const editor = await page()
    act(() => void editor.chain().focus().insertContent('/').run())
    const menu = await screen.findByRole('listbox', { name: 'Blocks' })
    expect([...menu.querySelectorAll('.md-menu__group')].map((group) => group.textContent)).toEqual(SLASH_GROUPS)
    const options = within(menu).getAllByRole('option')
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(options[0]?.querySelector('.md-menu__icon svg, .md-menu__icon span')).not.toBeNull()
    act(() => void key(editor, 'ArrowDown'))
    expect(within(menu).getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')
    act(() => void key(editor, 'Enter'))
    expect(screen.queryByRole('listbox', { name: 'Blocks' })).toBeNull()
    expect(lastWrite()).toBe('#\n')
  })

  it('filters as you type, without the group headings', async () => {
    mount('')
    const editor = await page()
    act(() => void editor.chain().focus().insertContent('/h2').run())
    const menu = await screen.findByRole('listbox', { name: 'Blocks' })
    expect(
      within(menu)
        .getAllByRole('option')
        .map((row) => row.textContent)
    ).toEqual(['Heading 2'])
    expect(menu.querySelector('.md-menu__group')).toBeNull()
  })

  it('reports nothing while open, and the result once it closes', async () => {
    mount('')
    const editor = await page()
    act(() => void editor.chain().focus().insertContent('/h').run())
    await screen.findByRole('listbox', { name: 'Blocks' })
    act(() => void editor.chain().insertContent('2').run())
    expect(onChange).not.toHaveBeenCalled()
    act(() => void key(editor, 'Escape'))
    expect(lastWrite()).toBe('/h2\n')
  })

  it('lets a line that matches no block through', async () => {
    mount('')
    const editor = await page()
    act(() => void editor.chain().focus().insertContent('/etc/hosts').run())
    await waitFor(() => expect(lastWrite()).toBe('/etc/hosts\n'))
    expect(screen.queryByRole('listbox', { name: 'Blocks' })).toBeNull()
  })

  it('closes on Escape and leaves the slash as typed', async () => {
    mount('')
    const editor = await page()
    act(() => void editor.chain().focus().insertContent('/').run())
    await screen.findByRole('listbox', { name: 'Blocks' })
    act(() => void key(editor, 'Escape'))
    expect(screen.queryByRole('listbox', { name: 'Blocks' })).toBeNull()
    expect(editor.state.doc.textContent).toBe('/')
  })
})

describe('the bar over a selection', () => {
  const select = (editor: Editor, from: number, to: number) =>
    act(() => void editor.chain().focus().setTextSelection({ from, to }).run())

  it('formats the selection and turns its block into another', async () => {
    mount('Some words here\n')
    const editor = await page()
    select(editor, 6, 11)
    const bar = await screen.findByRole('toolbar', { name: 'Format' })
    for (const label of ['Bold', 'Italic', 'Strikethrough', 'Code', 'Link']) {
      expect(within(bar).getByRole('button', { name: label })).toBeTruthy()
    }
    act(() => void fireEvent.click(within(bar).getByRole('button', { name: 'Bold' })))
    expect(lastWrite()).toBe('Some **words** here\n')
    act(() => void fireEvent.click(within(bar).getByRole('button', { name: 'Turn into' })))
    const kinds = await screen.findByRole('menu', { name: 'Turn into' })
    act(() => void fireEvent.click(within(kinds).getByRole('menuitem', { name: 'Heading 1' })))
    expect(lastWrite()).toBe('# Some **words** here\n')
  })

  it('is not there without a selection', async () => {
    mount('Some words here\n')
    const editor = await page()
    select(editor, 3, 3)
    expect(screen.queryByRole('toolbar', { name: 'Format' })).toBeNull()
  })
})

describe('the handle beside a block', () => {
  /** Lays the top-level blocks out one under another, 30px each, `left` from the frame's edge. */
  function layout(editor: Editor, left = 100): void {
    editor.state.doc.forEach((_node, offset, index) => {
      const dom = editor.view.nodeDOM(offset) as HTMLElement
      dom.getBoundingClientRect = () => new DOMRect(left, index * 30, 600, 24)
    })
  }

  async function hover(text: string, y: number, left = 100): Promise<{ editor: Editor; handle: HTMLElement }> {
    mount(text)
    const editor = await page()
    layout(editor, left)
    fireEvent.mouseMove(document.querySelector('.md-frame')!, { clientX: 300, clientY: y })
    const handle = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.md-handle')
      if (!found || found.hidden) throw new Error('no handle')
      return found
    })
    return { editor, handle }
  }

  it('opens a menu to turn the block into another, duplicate or delete it', async () => {
    const { handle } = await hover('first\n\nsecond\n', 40)
    act(() => void fireEvent.click(within(handle).getByRole('button', { name: 'Block menu' })))
    const menu = await screen.findByRole('menu', { name: 'Block' })
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
    expect(items).toEqual(expect.arrayContaining(['Text', 'Heading 1', 'Callout', 'Code', 'Duplicate', 'Delete']))
    act(() => void fireEvent.click(within(menu).getByRole('menuitem', { name: 'Heading 2' })))
    expect(lastWrite()).toBe('first\n\n## second\n')
  })

  it('deletes the block it is beside', async () => {
    const { handle } = await hover('first\n\nsecond\n', 10)
    act(() => void fireEvent.click(within(handle).getByRole('button', { name: 'Block menu' })))
    const menu = await screen.findByRole('menu', { name: 'Block' })
    act(() => void fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' })))
    expect(lastWrite()).toBe('second\n')
  })

  it('adds a line below with the / menu open', async () => {
    const { editor, handle } = await hover('first\n\nsecond\n', 10)
    act(() => void fireEvent.click(within(handle).getByRole('button', { name: 'Add below' })))
    await screen.findByRole('listbox', { name: 'Blocks' })
    expect(onChange).not.toHaveBeenCalled()
    act(() => void key(editor, 'Escape'))
    expect(lastWrite()).toBe('first\n\n/\n\nsecond\n')
  })

  it('stays inside a narrow page, whose gutter is narrower than the handle', async () => {
    const { handle } = await hover('first\n\nsecond\n', 10, 16)
    expect(parseFloat(handle.style.left)).toBeGreaterThanOrEqual(0)
  })

  it('starts a drag of its block', async () => {
    const { editor, handle } = await hover('first\n\nsecond\n', 40)
    const grip = within(handle).getByRole('button', { name: 'Block menu' })
    expect(grip.draggable).toBe(true)
    const transfer = { clearData() {}, setData() {}, setDragImage() {}, effectAllowed: 'none' }
    act(() => void fireEvent.dragStart(grip, { dataTransfer: transfer }))
    expect(editor.view.dragging?.slice.content.firstChild?.textContent).toBe('second')
  })
})
