// The page: a TipTap editor over the markdown schema, a `/` menu for every block,
// and a toolbar over a selection. Markdown in, markdown out; the file is the pane's.

import { Extension, type Editor, type Range } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/react'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { artifactTitle } from './artifactUrl'
import { markdownExtensions } from './markdownExtensions'
import { readMarkdownFile, writeMarkdownFile, type MarkdownFile } from './markdownFile'
import type { ImageResolver } from './markdownNodes'
import { slashItems, type SlashItem } from './slashCommands'

export type MarkdownEditorHandle = {
  /** Replaces the page with this file, without reporting it as an edit. */
  setMarkdown: (text: string) => void
  getMarkdown: () => string
  focus: () => void
}

export type MarkdownEditorProps = {
  initial: string
  onChange: (markdown: string) => void
  onFocusChange: (focused: boolean) => void
  onOpenUrl: (url: string) => void
  resolveImage: ImageResolver
}

type SlashMenuState = {
  items: SlashItem[]
  index: number
  rect: DOMRect | null
  command: (item: SlashItem) => void
}

type SlashMenuHooks = {
  show: (state: SlashMenuState | null) => void
  keyDown: (event: KeyboardEvent) => boolean
}

/** Inserts what a `/` row names, over the `/query` that named it. */
export function runSlashItem(editor: Editor, range: Range, item: SlashItem): void {
  const chain = editor.chain().focus().deleteRange(range)
  switch (item.id) {
    case 'text':
      chain.setParagraph().run()
      return
    case 'heading1':
    case 'heading2':
    case 'heading3':
      chain.setHeading({ level: Number(item.id.slice(-1)) as 1 | 2 | 3 }).run()
      return
    case 'bullets':
      chain.toggleBulletList().run()
      return
    case 'numbers':
      chain.toggleOrderedList().run()
      return
    case 'todo':
      chain.toggleTaskList().run()
      return
    case 'quote':
      chain.setBlockquote().run()
      return
    case 'callout':
      chain.setBlockquote().insertContent('<strong>Note:</strong> ').run()
      return
    case 'code':
      chain.setCodeBlock().run()
      return
    case 'table':
      chain.insertTable({ rows: 2, cols: 3, withHeaderRow: true }).run()
      return
    case 'divider':
      chain.setHorizontalRule().run()
      return
    case 'image':
      chain.setImage({ src: item.argument ?? '' }).run()
      return
    case 'artifact': {
      const url = item.argument ?? ''
      chain.insertContent({ type: 'artifactCard', attrs: { url, title: artifactTitle(url) } }).run()
      return
    }
  }
}

/** The `/` menu, as a ProseMirror plugin that reports to the component. */
function slashMenu(hooks: SlashMenuHooks): Extension {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      const editor = this.editor
      const publish = (props: SuggestionProps<SlashItem, SlashItem>): void => {
        hooks.show({
          items: props.items,
          index: 0,
          rect: props.clientRect?.() ?? null,
          command: (item) => props.command(item)
        })
      }
      return [
        Suggestion<SlashItem, SlashItem>({
          editor,
          char: '/',
          allowSpaces: true,
          items: ({ query }) => slashItems(query),
          command: ({ editor: target, range, props }) => runSlashItem(target, range, props),
          render: () => ({
            onStart: publish,
            onUpdate: publish,
            onExit: () => hooks.show(null),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => hooks.keyDown(event)
          })
        })
      ]
    }
  })
}

/** The selection's edges, in the scrolled page's coordinates. */
type Toolbar = { above: number; below: number; center: number }

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { initial, onChange, onFocusChange, onOpenUrl, resolveImage },
  ref
): React.JSX.Element {
  const frame = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<SlashMenuState | null>(null)
  const menuRef = useRef<SlashMenuState | null>(null)
  const [toolbar, setToolbar] = useState<Toolbar | null>(null)
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')
  // The latest callbacks, read by an editor built once.
  const latest = useRef({ onChange, onFocusChange, onOpenUrl })
  latest.current = { onChange, onFocusChange, onOpenUrl }
  // The file as last read; what the page did not change is written back from it.
  const [firstFile] = useState(() => readMarkdownFile(initial))
  const file = useRef<MarkdownFile>(firstFile)

  const hooks = useRef<SlashMenuHooks>({
    show: (state) => {
      menuRef.current = state
      setMenu(state)
    },
    keyDown: (event) => {
      const current = menuRef.current
      if (current === null || current.items.length === 0) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = { ...current, index: (current.index + step + current.items.length) % current.items.length }
        menuRef.current = next
        setMenu(next)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = current.items[current.index]
        if (item) current.command(item)
        return true
      }
      return false
    }
  })

  const [extensions] = useState(() => [
    ...markdownExtensions({ onOpenUrl: (url) => latest.current.onOpenUrl(url), resolveImage }),
    Placeholder.configure({ placeholder: 'Type / for blocks' }),
    slashMenu(hooks.current)
  ])

  const editor = useEditor({
    extensions,
    content: firstFile.doc,
    editorProps: {
      attributes: { class: 'md-editor', spellcheck: 'true' },
      handleClick: (_view, _pos, event) => {
        const anchor = (event.target as HTMLElement | null)?.closest('a')
        if (!anchor || !anchor.href) return false
        latest.current.onOpenUrl(anchor.href)
        return true
      }
    },
    onUpdate: ({ editor: updated, transaction }) => {
      // Only the page's own upkeep changed it, such as the trailing paragraph added on focus.
      if (!transaction.docChanged) return
      latest.current.onChange(writeMarkdownFile(updated.getJSON(), file.current))
    },
    onFocus: () => latest.current.onFocusChange(true),
    onBlur: () => latest.current.onFocusChange(false)
  })

  useImperativeHandle(
    ref,
    () => ({
      setMarkdown: (text) => {
        file.current = readMarkdownFile(text)
        editor?.commands.setContent(file.current.doc, { emitUpdate: false })
      },
      getMarkdown: () => (editor ? writeMarkdownFile(editor.getJSON(), file.current) : file.current.text),
      // A frame late: a click that focused the pane has placed its caret by then, and focusing
      // now would write the old selection over it before Chrome reports the move.
      focus: () =>
        void requestAnimationFrame(() => {
          if (editor && !editor.isDestroyed && !editor.view.hasFocus()) editor.commands.focus()
        })
    }),
    [editor]
  )

  // The toolbar follows a selection with something in it, and goes with it.
  const placeToolbar = useCallback(() => {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    const box = frame.current?.getBoundingClientRect()
    if (
      empty ||
      !editor.isFocused ||
      !box ||
      editor.isActive('codeBlock') ||
      editor.state.selection.constructor.name !== 'TextSelection'
    ) {
      setToolbar(null)
      setLinking(false)
      return
    }
    const start = editor.view.coordsAtPos(from)
    const end = editor.view.coordsAtPos(to)
    const scroll = frame.current?.scrollTop ?? 0
    setToolbar({
      above: start.top - box.top + scroll,
      below: end.bottom - box.top + scroll,
      center: (start.left + end.left) / 2 - box.left
    })
  }, [editor])

  // Above the selection when it fits, else below; never past either side of the page.
  const bar = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = frame.current
    if (!toolbar || !bar.current || !host) return
    const gap = 6
    const { offsetWidth: width, offsetHeight: height } = bar.current
    const top = toolbar.above - height - gap < host.scrollTop ? toolbar.below + gap : toolbar.above - height - gap
    const left = Math.max(gap, Math.min(toolbar.center - width / 2, host.clientWidth - width - gap))
    bar.current.style.top = `${top}px`
    bar.current.style.left = `${left}px`
  }, [toolbar, linking])

  useEffect(() => {
    if (!editor) return
    editor.on('selectionUpdate', placeToolbar)
    editor.on('blur', placeToolbar)
    editor.on('focus', placeToolbar)
    return () => {
      editor.off('selectionUpdate', placeToolbar)
      editor.off('blur', placeToolbar)
      editor.off('focus', placeToolbar)
    }
  }, [editor, placeToolbar])

  // Keep the highlighted row in view as the arrows walk the list.
  const list = useRef<HTMLUListElement | null>(null)
  useLayoutEffect(() => {
    if (!menu) return
    list.current?.children[menu.index]?.scrollIntoView({ block: 'nearest' })
  }, [menu])

  const menuPlace = (): React.CSSProperties => {
    const box = frame.current?.getBoundingClientRect()
    if (!menu?.rect || !box) return { top: 0, left: 0 }
    const scroll = frame.current?.scrollTop ?? 0
    return { top: menu.rect.bottom - box.top + scroll + 4, left: Math.max(0, menu.rect.left - box.left) }
  }

  const setLink = (): void => {
    if (!editor) return
    const target = href.trim()
    if (target.length === 0) editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: target }).run()
    setLinking(false)
  }

  const mark = (name: string, label: string, toggle: () => void): React.JSX.Element => (
    <button
      type="button"
      className={`md-toolbar__button${editor?.isActive(name) ? ' md-toolbar__button--on' : ''}`}
      // The toolbar must not take the selection with it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {label}
    </button>
  )

  return (
    <div className="md-frame" ref={frame}>
      <EditorContent editor={editor} className="md-content" />

      {menu && menu.items.length > 0 ? (
        <ul className="md-menu" role="listbox" aria-label="Blocks" style={menuPlace()} ref={list}>
          {menu.items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === menu.index}
              className={`md-menu__row${index === menu.index ? ' md-menu__row--current' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => {
                const next = { ...menu, index }
                menuRef.current = next
                setMenu(next)
              }}
              onClick={() => menu.command(item)}
            >
              <span className="md-menu__label">{item.label}</span>
              <span className="md-menu__detail">{item.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {toolbar && editor ? (
        <div className="md-toolbar" role="toolbar" aria-label="Format" ref={bar}>
          <select
            className="md-toolbar__turn"
            aria-label="Turn into"
            value={blockOf(editor)}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => turnInto(editor, event.target.value)}
          >
            <option value="paragraph">Text</option>
            <option value="heading1">Heading 1</option>
            <option value="heading2">Heading 2</option>
            <option value="heading3">Heading 3</option>
            <option value="bulletList">Bullets</option>
            <option value="orderedList">Numbers</option>
            <option value="taskList">To-do</option>
            <option value="blockquote">Quote</option>
          </select>
          {mark('bold', 'B', () => editor.chain().focus().toggleBold().run())}
          {mark('italic', 'I', () => editor.chain().focus().toggleItalic().run())}
          {mark('strike', 'S', () => editor.chain().focus().toggleStrike().run())}
          {mark('code', '<>', () => editor.chain().focus().toggleCode().run())}
          {linking ? (
            <input
              className="md-toolbar__href"
              type="url"
              value={href}
              placeholder="https://"
              aria-label="Link address"
              autoFocus
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setLink()
                if (event.key === 'Escape') setLinking(false)
              }}
            />
          ) : (
            mark('link', 'Link', () => {
              setHref(String(editor.getAttributes('link').href ?? ''))
              setLinking(true)
            })
          )}
        </div>
      ) : null}
    </div>
  )
})

/** Which row of the turn-into list the selection's block is on. */
function blockOf(editor: Editor): string {
  for (const level of [1, 2, 3] as const) if (editor.isActive('heading', { level })) return `heading${level}`
  for (const name of ['taskList', 'bulletList', 'orderedList', 'blockquote']) if (editor.isActive(name)) return name
  return 'paragraph'
}

function turnInto(editor: Editor, block: string): void {
  const chain = editor.chain().focus()
  // Out of whatever list or quote the block is in first, so a heading does
  // not land inside a bullet.
  if (editor.isActive('bulletList')) chain.toggleBulletList()
  if (editor.isActive('orderedList')) chain.toggleOrderedList()
  if (editor.isActive('taskList')) chain.toggleTaskList()
  if (editor.isActive('blockquote')) chain.unsetBlockquote()
  switch (block) {
    case 'heading1':
    case 'heading2':
    case 'heading3':
      chain.setHeading({ level: Number(block.slice(-1)) as 1 | 2 | 3 })
      break
    case 'bulletList':
      chain.setParagraph().toggleBulletList()
      break
    case 'orderedList':
      chain.setParagraph().toggleOrderedList()
      break
    case 'taskList':
      chain.setParagraph().toggleTaskList()
      break
    case 'blockquote':
      chain.setParagraph().setBlockquote()
      break
    default:
      chain.setParagraph()
  }
  chain.run()
}
