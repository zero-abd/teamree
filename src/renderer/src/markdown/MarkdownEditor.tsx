// The page: a TipTap editor over the markdown schema, with a `/` menu, a handle
// beside each block and a bar over a selection. Markdown in, markdown out.

import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/react'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { BlockHandle } from './BlockHandle'
import { FormatBar } from './FormatBar'
import { markdownExtensions } from './markdownExtensions'
import { readMarkdownFile, writeMarkdownFile, type MarkdownFile } from './markdownFile'
import type { ImageResolver } from './markdownNodes'
import { MarkdownPaste } from './markdownPaste'
import { runSlashItem, slashItems, type SlashItem } from './slashCommands'
import { SlashMenu, type SlashMenuState } from './SlashMenu'

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

type SlashMenuHooks = {
  show: (state: SlashMenuState | null) => void
  keyDown: (event: KeyboardEvent) => boolean
  /** Whether the menu is open, loading or listing blocks; the page is not reported meanwhile. */
  hold: (editor: Editor, open: boolean) => void
}

/** The `/` menu, as a ProseMirror plugin that reports to the component. */
function slashMenu(hooks: SlashMenuHooks): Extension {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      const publish = (props: SuggestionProps<SlashItem, SlashItem>): void => {
        hooks.hold(props.editor, props.loading || props.items.length > 0)
        hooks.show({
          items: props.items,
          query: props.query,
          index: 0,
          rect: props.clientRect?.() ?? null,
          command: (item) => props.command(item)
        })
      }
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: '/',
          allowSpaces: true,
          items: ({ query }) => slashItems(query),
          command: ({ editor: target, range, props }) => runSlashItem(target, range, props),
          render: () => ({
            onStart: publish,
            onUpdate: publish,
            onExit: ({ editor: target }) => {
              hooks.hold(target, false)
              hooks.show(null)
            },
            onKeyDown: ({ event }: SuggestionKeyDownProps) => hooks.keyDown(event)
          })
        })
      ]
    }
  })
}

/** The hint an empty line shows while the caret is on it. */
function placeholderFor({ editor, node, pos }: { editor: Editor; node: ProseNode; pos: number }): string {
  if (node.type.name === 'heading') return `Heading ${String(node.attrs.level)}`
  if (node.type.name !== 'paragraph') return ''
  const parent = editor.state.doc.resolve(pos).parent.type.name
  if (parent === 'doc') return "Type '/' for commands"
  if (parent === 'listItem') return 'List'
  if (parent === 'taskItem') return 'To-do'
  return ''
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { initial, onChange, onFocusChange, onOpenUrl, resolveImage },
  ref
): React.JSX.Element {
  const frame = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<SlashMenuState | null>(null)
  const menuRef = useRef<SlashMenuState | null>(null)
  // The latest callbacks, read by an editor built once.
  const latest = useRef({ onChange, onFocusChange, onOpenUrl })
  latest.current = { onChange, onFocusChange, onOpenUrl }
  // The file as last read; what the page did not change is written back from it.
  const [firstFile] = useState(() => readMarkdownFile(initial))
  const file = useRef<MarkdownFile>(firstFile)
  // The `/` and its query are never written; the page is reported once the menu closes.
  const held = useRef(false)

  const showMenu = (state: SlashMenuState | null): void => {
    menuRef.current = state
    setMenu(state)
  }
  const hooks = useRef<SlashMenuHooks>({
    show: showMenu,
    hold: (target, open) => {
      const released = held.current && !open
      held.current = open
      if (released) latest.current.onChange(writeMarkdownFile(target.getJSON(), file.current))
    },
    keyDown: (event) => {
      const current = menuRef.current
      if (current === null || current.items.length === 0) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1
        showMenu({ ...current, index: (current.index + step + current.items.length) % current.items.length })
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
    Placeholder.configure({ placeholder: placeholderFor, includeChildren: true }),
    MarkdownPaste,
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
      if (!transaction.docChanged || held.current) return
      latest.current.onChange(writeMarkdownFile(updated.getJSON(), file.current))
    },
    // A page closed with the menu open drops the query.
    onDestroy: () => void (held.current = false),
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

  return (
    <div className="md-frame" ref={frame}>
      <EditorContent editor={editor} className="md-content" />
      {editor ? <BlockHandle editor={editor} frame={frame} /> : null}
      {editor ? <FormatBar editor={editor} frame={frame} /> : null}
      {menu && menu.items.length > 0 ? (
        <SlashMenu menu={menu} frame={frame} onHover={(index) => showMenu({ ...menu, index })} />
      ) : null}
    </div>
  )
})
