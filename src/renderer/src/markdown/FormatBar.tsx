// The bar over a selection: what the block is and what it can become, the marks, a link.

import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { blockKindOf, turnInto } from './blockActions'
import { BlockIcon, type IconName } from './blockIcons'
import { inFrame, placeBeside, type Anchor } from './floating'
import { KindRows, kindLabel } from './KindMenu'

type Mark = { name: string; label: string; icon: IconName | string; toggle: (editor: Editor) => void }

const MARKS: readonly Mark[] = [
  { name: 'bold', label: 'Bold', icon: 'B', toggle: (editor) => editor.chain().focus().toggleBold().run() },
  { name: 'italic', label: 'Italic', icon: 'I', toggle: (editor) => editor.chain().focus().toggleItalic().run() },
  {
    name: 'strike',
    label: 'Strikethrough',
    icon: 'S',
    toggle: (editor) => editor.chain().focus().toggleStrike().run()
  },
  { name: 'code', label: 'Code', icon: 'code', toggle: (editor) => editor.chain().focus().toggleCode().run() }
]

export function FormatBar({
  editor,
  frame
}: {
  editor: Editor
  frame: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [linking, setLinking] = useState(false)
  const [turning, setTurning] = useState(false)
  const [href, setHref] = useState('')
  const bar = useRef<HTMLDivElement | null>(null)

  // Follows a selection with something in it, and goes with it.
  const place = useCallback(() => {
    const host = frame.current
    const { selection } = editor.state
    if (
      !host ||
      selection.empty ||
      !(selection instanceof TextSelection) ||
      !editor.isFocused ||
      editor.isActive('codeBlock')
    ) {
      setAnchor(null)
      setLinking(false)
      setTurning(false)
      return
    }
    const start = editor.view.coordsAtPos(selection.from)
    const end = editor.view.coordsAtPos(selection.to)
    const edges = inFrame(host, { top: start.top, bottom: end.bottom, left: start.left, right: end.left })
    setAnchor({ ...edges, left: Math.min(edges.left, edges.right), right: Math.max(edges.left, edges.right) })
  }, [editor, frame])

  useEffect(() => {
    const leave = ({ event }: { event: FocusEvent }): void => {
      // Into the bar's own link field: the selection stays, and so does the bar.
      if (bar.current?.contains(event.relatedTarget as Node | null)) return
      place()
    }
    // Every transaction, not only a moved selection: a toggled mark redraws its button.
    editor.on('transaction', place)
    editor.on('focus', place)
    editor.on('blur', leave)
    return () => {
      editor.off('transaction', place)
      editor.off('focus', place)
      editor.off('blur', leave)
    }
  }, [editor, place])

  useLayoutEffect(() => {
    const host = frame.current
    if (anchor && bar.current && host) placeBeside(bar.current, host, anchor, { prefer: 'above', center: true })
  }, [anchor, frame, linking])

  if (!anchor) return null

  const setLink = (): void => {
    const target = href.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (target.length === 0) chain.unsetLink().run()
    else chain.setLink({ href: target }).run()
    setLinking(false)
  }

  const kind = blockKindOf(editor)
  return (
    <div className="md-bar" role="toolbar" aria-label="Format" ref={bar}>
      <button
        type="button"
        className="md-bar__button md-bar__turn"
        aria-label="Turn into"
        aria-haspopup="menu"
        aria-expanded={turning}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setTurning(!turning)}
      >
        {kindLabel(kind)}
        <BlockIcon name="chevron" />
      </button>
      <span className="md-bar__rule" />
      {MARKS.map((mark) => (
        <button
          key={mark.name}
          type="button"
          className={`md-bar__button md-bar__mark--${mark.name}${
            editor.isActive(mark.name) ? ' md-bar__button--on' : ''
          }`}
          aria-label={mark.label}
          title={mark.label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => mark.toggle(editor)}
        >
          {mark.icon.length === 1 ? mark.icon : <BlockIcon name={mark.icon as IconName} />}
        </button>
      ))}
      {linking ? (
        <input
          className="md-bar__href"
          type="url"
          value={href}
          placeholder="https://"
          aria-label="Link address"
          autoFocus
          onChange={(event) => setHref(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setLink()
            if (event.key === 'Escape') {
              setLinking(false)
              editor.commands.focus()
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`md-bar__button${editor.isActive('link') ? ' md-bar__button--on' : ''}`}
          aria-label="Link"
          title="Link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setHref(String(editor.getAttributes('link').href ?? ''))
            setTurning(false)
            setLinking(true)
          }}
        >
          <BlockIcon name="link" />
        </button>
      )}
      {turning ? (
        <div className="md-popover md-bar__kinds" role="menu" aria-label="Turn into">
          <KindRows
            current={kind}
            onPick={(next) => {
              setTurning(false)
              turnInto(editor, next)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
