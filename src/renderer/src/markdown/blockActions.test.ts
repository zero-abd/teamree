/** @vitest-environment jsdom */
import { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import {
  blockAt,
  blockKindOf,
  deleteBlock,
  duplicateBlock,
  insertBlockBelow,
  startBlockDrag,
  turnBlockInto,
  turnInto,
  type BlockKind
} from './blockActions'
import { serializeMarkdown } from './markdownDocument'
import { markdownExtensions } from './markdownExtensions'
import { readMarkdownFile } from './markdownFile'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function page(text: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: markdownExtensions(),
    content: readMarkdownFile(text).doc
  })
  return editor
}

const written = (target: Editor): string => serializeMarkdown(target.getJSON())

/** The position of the innermost block of `type` holding `text`. */
function blockPos(target: Editor, type: string, text: string): number {
  let at = -1
  target.state.doc.descendants((node, pos) => {
    if (node.type.name === type && node.textContent.includes(text)) at = pos
  })
  if (at === -1) throw new Error(`no ${type} holds ${text}`)
  return at
}

describe('turning a line into another block', () => {
  it.each<[BlockKind, string]>([
    ['paragraph', 'line\n'],
    ['heading1', '# line\n'],
    ['heading2', '## line\n'],
    ['heading3', '### line\n'],
    ['bulletList', '- line\n'],
    ['orderedList', '1. line\n'],
    ['taskList', '- [ ] line\n'],
    ['blockquote', '> line\n'],
    ['callout', '> [!NOTE]\n> line\n'],
    ['codeBlock', '```\nline\n```\n']
  ])('from a paragraph into %s', (kind, expected) => {
    const target = page('line\n')
    target.commands.setTextSelection(2)
    expect(turnInto(target, kind)).toBe(true)
    expect(written(target)).toBe(expected)
    expect(blockKindOf(target)).toBe(kind)
  })

  it.each<[string, BlockKind, string]>([
    ['- line\n', 'heading2', '## line\n'],
    ['- line\n', 'orderedList', '1. line\n'],
    ['1. line\n', 'taskList', '- [ ] line\n'],
    ['# line\n', 'callout', '> [!NOTE]\n> line\n'],
    ['> [!TIP]\n> line\n', 'paragraph', 'line\n'],
    ['> line\n', 'bulletList', '- line\n'],
    ['```\nline\n```\n', 'heading1', '# line\n']
  ])('from %j into %s', (text, kind, expected) => {
    const target = page(text)
    let pos = -1
    target.state.doc.descendants((node, offset) => {
      if (pos === -1 && node.isText) pos = offset + 2
    })
    target.commands.setTextSelection(pos)
    expect(turnInto(target, kind)).toBe(true)
    expect(written(target)).toBe(expected)
  })

  it('turns the block a handle points at, wherever the caret is', () => {
    const target = page('first\n\nsecond\n')
    target.commands.setTextSelection(2)
    turnBlockInto(target, blockPos(target, 'paragraph', 'second'), 'heading1')
    expect(written(target)).toBe('first\n\n# second\n')
  })
})

describe('the block menu', () => {
  it('duplicates a block below itself', () => {
    const target = page('# Title\n\nbody\n')
    duplicateBlock(target, blockPos(target, 'heading', 'Title'))
    expect(written(target)).toBe('# Title\n\n# Title\n\nbody\n')
  })

  it('duplicates one list item within its list', () => {
    const target = page('- one\n- two\n')
    duplicateBlock(target, blockPos(target, 'listItem', 'one'))
    expect(written(target)).toBe('- one\n- one\n- two\n')
  })

  it('deletes a block, a list item, and the list with its last item', () => {
    const target = page('keep\n\ngone\n\n- a\n- b\n')
    deleteBlock(target, blockPos(target, 'paragraph', 'gone'))
    expect(written(target)).toBe('keep\n\n- a\n- b\n')
    deleteBlock(target, blockPos(target, 'listItem', 'a'))
    expect(written(target)).toBe('keep\n\n- b\n')
    deleteBlock(target, blockPos(target, 'listItem', 'b'))
    expect(written(target)).toBe('keep\n')
  })

  it('leaves an empty line when the only block is deleted', () => {
    const target = page('only\n')
    deleteBlock(target, 0)
    expect(target.state.doc.childCount).toBe(1)
    expect(written(target)).toBe('')
  })
})

describe('the + beside a block', () => {
  it('opens a line below with a slash, ready for the menu', () => {
    const target = page('first\n\nlast\n')
    insertBlockBelow(target, blockPos(target, 'paragraph', 'first'))
    expect(written(target)).toBe('first\n\n/\n\nlast\n')
    const { $from } = target.state.selection
    expect($from.parent.textContent).toBe('/')
    expect($from.parentOffset).toBe(1)
  })

  it('adds an item of the same kind below a list item', () => {
    const target = page('- [x] done\n')
    insertBlockBelow(target, blockPos(target, 'taskItem', 'done'))
    expect(written(target)).toBe('- [x] done\n- [ ] /\n')
  })

  it('types the slash into an empty line instead of adding another', () => {
    const target = page('first\n')
    target.commands.insertContentAt(target.state.doc.content.size, { type: 'paragraph' })
    const empty = target.state.doc.child(0).nodeSize
    insertBlockBelow(target, empty)
    expect(target.state.doc.childCount).toBe(2)
    expect(written(target)).toBe('first\n\n/\n')
  })
})

describe('the block under the pointer', () => {
  /** Lays each block's element out at the given top and bottom, as layout would. */
  function layout(target: Editor, rows: Record<string, [number, number]>): void {
    target.state.doc.descendants((node, pos) => {
      const dom = target.view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return
      const key = `${node.type.name}:${node.textContent}`
      const row = rows[key]
      if (row) dom.getBoundingClientRect = () => new DOMRect(40, row[0], 600, row[1] - row[0])
      else dom.getBoundingClientRect = () => new DOMRect(40, -1000, 600, 0)
    })
  }

  it('is the top-level block at that height, or the nearest below a gap', () => {
    const target = page('# Title\n\nbody\n')
    layout(target, { 'heading:Title': [0, 40], 'paragraph:body': [52, 76] })
    expect(blockAt(target.view, 20)?.node.type.name).toBe('heading')
    expect(blockAt(target.view, 46)?.node.textContent).toBe('body')
    expect(blockAt(target.view, 500)?.node.textContent).toBe('body')
  })

  it('is the list item, and the nested item when the pointer is on it', () => {
    const target = page('- one\n  - inner\n- two\n')
    layout(target, {
      'bulletList:oneinnertwo': [0, 72],
      'listItem:oneinner': [0, 48],
      'paragraph:one': [0, 24],
      'bulletList:inner': [24, 48],
      'listItem:inner': [24, 48],
      'listItem:two': [48, 72]
    })
    expect(blockAt(target.view, 10)?.node.textContent).toBe('oneinner')
    expect(blockAt(target.view, 30)?.node.textContent).toBe('inner')
    expect(blockAt(target.view, 60)?.node.textContent).toBe('two')
  })
})

describe('dragging a block by its handle', () => {
  it('selects the block and hands the page a move of exactly that block', () => {
    const target = page('first\n\nsecond\n')
    const pos = blockPos(target, 'paragraph', 'second')
    const data = new Map<string, string>()
    const transfer = {
      clearData: () => data.clear(),
      setData: (type: string, value: string) => void data.set(type, value),
      setDragImage: () => {},
      effectAllowed: 'none'
    } as unknown as DataTransfer
    startBlockDrag(target.view, pos, transfer)
    expect(target.state.selection).toBeInstanceOf(NodeSelection)
    expect(target.state.selection.from).toBe(pos)
    expect(target.view.dragging?.move).toBe(true)
    expect(target.view.dragging?.slice.content.firstChild?.textContent).toBe('second')
    expect(data.get('text/plain')).toBe('second')
    expect(transfer.effectAllowed).toBe('move')
  })
})
