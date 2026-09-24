// The handle beside the block under the pointer: + opens a line below, the grip
// drags the block or opens its menu (turn into, duplicate, delete).

import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  blockAt,
  blockKindAt,
  canTurn,
  deleteBlock,
  duplicateBlock,
  insertBlockBelow,
  startBlockDrag,
  turnBlockInto,
  type Block
} from './blockActions'
import { BlockIcon } from './blockIcons'
import { inFrame, placeBeside, type Anchor } from './floating'
import { KindRows, MenuRow } from './KindMenu'

const HANDLE_WIDTH = 44
const HANDLE_HEIGHT = 24

type Target = { block: Block; top: number; left: number }

/** Where the handle goes for a block: left of it (of its list, for an item), level with its first line; over it on a narrow page. */
function targetOf(editor: Editor, host: HTMLElement, block: Block): Target {
  const item = block.node.type.name === 'listItem' || block.node.type.name === 'taskItem'
  const edge = item ? (block.dom.parentElement ?? block.dom) : block.dom
  const box = inFrame(host, edge.getBoundingClientRect())
  let middle = inFrame(host, block.dom.getBoundingClientRect()).top + HANDLE_HEIGHT / 2
  if (block.node.isTextblock || item) {
    try {
      const line = editor.view.coordsAtPos(block.pos + (item ? 2 : 1))
      if (line.bottom > line.top) middle = inFrame(host, line).top + (line.bottom - line.top) / 2
    } catch {
      // A block with no text to measure keeps its top edge.
    }
  }
  return { block, top: middle - HANDLE_HEIGHT / 2, left: Math.max(0, box.left - HANDLE_WIDTH - 4) }
}

export function BlockHandle({
  editor,
  frame
}: {
  editor: Editor
  frame: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [target, setTarget] = useState<Target | null>(null)
  const [menu, setMenu] = useState(false)
  const open = useRef(false)
  open.current = menu
  const popover = useRef<HTMLDivElement | null>(null)
  const handle = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = frame.current
    if (!host) return
    const move = (event: MouseEvent): void => {
      if (open.current || !editor.isEditable) return
      if ((event.target as Element | null)?.closest?.('.md-handle, .md-popover, .md-menu, .md-bar')) return
      const block = blockAt(editor.view, event.clientY)
      setTarget(block ? targetOf(editor, host, block) : null)
    }
    const leave = (): void => {
      if (!open.current) setTarget(null)
    }
    // Typing hides it; the pointer brings it back.
    const changed = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
      if (!transaction.docChanged) return
      setMenu(false)
      setTarget(null)
    }
    host.addEventListener('mousemove', move)
    host.addEventListener('mouseleave', leave)
    editor.on('transaction', changed)
    return () => {
      host.removeEventListener('mousemove', move)
      host.removeEventListener('mouseleave', leave)
      editor.off('transaction', changed)
    }
  }, [editor, frame])

  // Escape or a click anywhere else puts the menu away.
  useEffect(() => {
    if (!menu) return
    const away = (event: MouseEvent): void => {
      const inside =
        event.target instanceof Node &&
        (popover.current?.contains(event.target) || handle.current?.contains(event.target))
      if (!inside) setMenu(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenu(false)
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [menu])

  useLayoutEffect(() => {
    const host = frame.current
    if (!menu || !target || !popover.current || !host) return
    const anchor: Anchor = {
      top: target.top,
      bottom: target.top + HANDLE_HEIGHT,
      left: target.left,
      right: target.left
    }
    placeBeside(popover.current, host, anchor)
  }, [frame, menu, target])

  if (!target) return null
  const { block } = target
  const act = (run: () => void): void => {
    setMenu(false)
    run()
  }
  const openMenu = (): void => {
    // The block shows as chosen while its menu is up.
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)))
    setMenu(!menu)
  }
  const kind = canTurn(block.node) ? blockKindAt(editor, block.pos) : null

  return (
    <>
      <div className="md-handle" ref={handle} style={{ top: target.top, left: target.left }}>
        <button
          type="button"
          className="md-handle__button"
          aria-label="Add below"
          title="Add below"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => act(() => insertBlockBelow(editor, block.pos))}
        >
          <BlockIcon name="plus" />
        </button>
        <button
          type="button"
          className="md-handle__button md-handle__grip"
          aria-label="Block menu"
          aria-haspopup="menu"
          aria-expanded={menu}
          title="Drag to move"
          draggable
          onClick={openMenu}
          onDragStart={(event) => {
            setMenu(false)
            startBlockDrag(editor.view, block.pos, event.dataTransfer)
          }}
          onDragEnd={() => {
            // A drop outside the page leaves the drag to be cleared here.
            editor.view.dragging = null
          }}
        >
          <BlockIcon name="grip" />
        </button>
      </div>
      {menu ? (
        <div className="md-popover" role="menu" aria-label="Block" ref={popover}>
          {canTurn(block.node) ? (
            <>
              <div className="md-popover__title">Turn into</div>
              <KindRows current={kind} onPick={(next) => act(() => turnBlockInto(editor, block.pos, next))} />
              <div className="md-popover__rule" role="separator" />
            </>
          ) : null}
          <MenuRow icon="duplicate" label="Duplicate" onPick={() => act(() => duplicateBlock(editor, block.pos))} />
          <MenuRow icon="trash" label="Delete" danger onPick={() => act(() => deleteBlock(editor, block.pos))} />
        </div>
      ) : null}
    </>
  )
}
