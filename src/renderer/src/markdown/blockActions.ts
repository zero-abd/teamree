// What can be done to one block: turn it into another, duplicate, delete, add
// one below, drag it. A block is a top-level node, or a list item within a list.

import type { Editor } from '@tiptap/core'
import type { Node as ProseNode, ResolvedPos } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export type BlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'callout'
  | 'codeBlock'

export const BLOCK_KINDS: readonly { kind: BlockKind; label: string }[] = [
  { kind: 'paragraph', label: 'Text' },
  { kind: 'heading1', label: 'Heading 1' },
  { kind: 'heading2', label: 'Heading 2' },
  { kind: 'heading3', label: 'Heading 3' },
  { kind: 'bulletList', label: 'Bulleted list' },
  { kind: 'orderedList', label: 'Numbered list' },
  { kind: 'taskList', label: 'To-do list' },
  { kind: 'blockquote', label: 'Quote' },
  { kind: 'callout', label: 'Callout' },
  { kind: 'codeBlock', label: 'Code' }
]

const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])
const ITEMS = new Set(['listItem', 'taskItem'])

/** The kind of block the caret is in, read from the innermost container out. */
export function blockKindOf(editor: Editor): BlockKind {
  return kindAt(editor.state.selection.$from)
}

/** The kind of the block at the start of the block at `pos`, or null for one with no text. */
export function blockKindAt(editor: Editor, pos: number): BlockKind | null {
  const found = Selection.findFrom(editor.state.doc.resolve(pos + 1), 1, true)
  return found && found.from < pos + (editor.state.doc.nodeAt(pos)?.nodeSize ?? 0) ? kindAt(found.$from) : null
}

function kindAt($from: ResolvedPos): BlockKind {
  const block = $from.parent
  if (block.type.name === 'heading') return `heading${Math.min(3, Number(block.attrs.level) || 1)}` as BlockKind
  if (block.type.name === 'codeBlock') return 'codeBlock'
  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name
    if (name === 'taskItem') return 'taskList'
    if (LISTS.has(name) || name === 'blockquote' || name === 'callout') return name as BlockKind
  }
  return 'paragraph'
}

/** Turns the caret's block into `kind`, out of any list or quote it was in first. */
export function turnInto(editor: Editor, kind: BlockKind): boolean {
  if (blockKindOf(editor) === kind) return true
  const chain = editor.chain().focus().clearNodes()
  switch (kind) {
    case 'heading1':
    case 'heading2':
    case 'heading3':
      chain.setHeading({ level: Number(kind.slice(-1)) as 1 | 2 | 3 })
      break
    case 'bulletList':
      chain.toggleBulletList()
      break
    case 'orderedList':
      chain.toggleOrderedList()
      break
    case 'taskList':
      chain.toggleTaskList()
      break
    case 'blockquote':
      chain.setBlockquote()
      break
    case 'callout':
      chain.wrapIn('callout', { kind: 'note' })
      break
    case 'codeBlock':
      chain.setCodeBlock()
      break
    case 'paragraph':
      // Clearing the containers has already made the line a paragraph.
      break
  }
  return chain.run()
}

/** Whether the block at `pos` holds text that can become another kind of block. */
export function canTurn(node: ProseNode): boolean {
  return node.isTextblock || ITEMS.has(node.type.name) || ['blockquote', 'callout'].includes(node.type.name)
}

/** Puts the caret at the start of the block at `pos`. */
function caretInto(editor: Editor, pos: number): void {
  const { state } = editor
  const found = Selection.findFrom(state.doc.resolve(pos + 1), 1, true)
  if (found) editor.view.dispatch(state.tr.setSelection(found))
}

export function turnBlockInto(editor: Editor, pos: number, kind: BlockKind): boolean {
  caretInto(editor, pos)
  return turnInto(editor, kind)
}

export function duplicateBlock(editor: Editor, pos: number): void {
  const { state } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return
  const at = pos + node.nodeSize
  const tr = state.tr.insert(at, node)
  editor.view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(at + 1))).scrollIntoView())
}

export function deleteBlock(editor: Editor, pos: number): void {
  const { state } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return
  // Widens to the list when this is its only item, so no empty list is left behind.
  const tr = state.tr.deleteRange(pos, pos + node.nodeSize)
  editor.view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)))))
}

/** Opens a line below the block with `/` typed, so the menu comes up on it. */
export function insertBlockBelow(editor: Editor, pos: number): void {
  const { state } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return
  const { schema } = state
  const tr = state.tr
  if (node.type.name === 'paragraph' && node.childCount === 0) {
    tr.setSelection(TextSelection.create(tr.doc, pos + 1)).insertText('/')
  } else {
    const at = pos + node.nodeSize
    const line = schema.nodes.paragraph!.create(null, schema.text('/'))
    const item = ITEMS.has(node.type.name)
    const block = item ? node.type.create(node.type.name === 'taskItem' ? { checked: false } : null, line) : line
    tr.insert(at, block)
    tr.setSelection(TextSelection.create(tr.doc, at + (item ? 3 : 2)))
  }
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
}

export type Block = { pos: number; node: ProseNode; dom: HTMLElement }

/** The block at height `y` on screen: the top-level block there, or the list item within it. */
export function blockAt(view: EditorView, y: number): Block | null {
  const pick = (parent: ProseNode, start: number): Block | null => {
    let last: Block | null = null
    let offset = start
    for (let index = 0; index < parent.childCount; index += 1) {
      const node = parent.child(index)
      const pos = offset
      offset += node.nodeSize
      const dom = view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) continue
      last = { pos, node, dom }
      if (y <= dom.getBoundingClientRect().bottom) break
    }
    return last
  }
  const within = (block: Block): Block => {
    if (LISTS.has(block.node.type.name)) {
      const item = pick(block.node, block.pos + 1)
      return item ? within(item) : block
    }
    if (ITEMS.has(block.node.type.name)) {
      let offset = block.pos + 1
      for (let index = 0; index < block.node.childCount; index += 1) {
        const child = block.node.child(index)
        const dom = view.nodeDOM(offset)
        if (LISTS.has(child.type.name) && dom instanceof HTMLElement && y >= dom.getBoundingClientRect().top) {
          const inner = pick(child, offset + 1)
          if (inner) return within(inner)
        }
        offset += child.nodeSize
      }
    }
    return block
  }
  const top = pick(view.state.doc, 0)
  return top ? within(top) : null
}

/** Selects the block at `pos` and hands the page a move of it, as its own drag would. */
export function startBlockDrag(view: EditorView, pos: number, transfer: DataTransfer): void {
  const selection = NodeSelection.create(view.state.doc, pos)
  view.dispatch(view.state.tr.setSelection(selection))
  const slice = selection.content()
  const { dom, text } = view.serializeForClipboard(slice)
  transfer.clearData()
  transfer.setData('text/html', dom.innerHTML)
  transfer.setData('text/plain', text)
  transfer.effectAllowed = 'move'
  const block = view.nodeDOM(pos)
  if (block instanceof HTMLElement) transfer.setDragImage(block, 0, 0)
  // The page's drop reads `node` to delete the original, typed only on its own drags.
  view.dragging = { slice, move: true, node: selection } as EditorView['dragging']
}
