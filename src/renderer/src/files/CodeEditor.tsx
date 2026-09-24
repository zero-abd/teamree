// A CodeMirror 6 editor over one file's text. The pane owns reading and
// writing; this owns the document and says when it differs from what is saved.

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Text } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { loadLanguage } from './codeLanguage'
import { codeTheme } from './codeTheme'

export type CodeEditorHandle = {
  /** The document as it would be written, in the file's own line endings. */
  text: () => string
  /** Records `text` as what is on disk, so the editor is clean when it matches. */
  markSaved: (text: string) => void
  /** Replaces the whole document, clean, keeping the cursor where it can. */
  replace: (text: string) => void
}

export type CodeEditorProps = {
  ref?: Ref<CodeEditorHandle>
  path: string
  /** What is on disk. */
  savedText: string
  /** What to show instead, when edits were kept from before a remount. */
  draftText?: string
  lineEnding: '\n' | '\r\n'
  focused: boolean
  onDirtyChange: (dirty: boolean) => void
  /** Every change to the document. */
  onEdit: () => void
  /** A comment asked for on `lines`, the first being line `from` (from 1): the gutter's `+`, or ⌘⇧A. */
  onComment?: (from: number, lines: string[]) => void
  /** A line to put the cursor on and bring into view, once per `token`; 1-based. */
  goTo?: { line: number; column: number; token: number }
  onWent?: (token: number) => void
}

class PlusMarker extends GutterMarker {
  override toDOM(): Node {
    const plus = document.createElement('span')
    plus.textContent = '+'
    plus.setAttribute('aria-hidden', 'true')
    return plus
  }
}

const PLUS = new PlusMarker()

export function CodeEditor({
  ref,
  path,
  savedText,
  draftText,
  lineEnding,
  focused,
  onDirtyChange,
  onEdit,
  onComment,
  goTo,
  onWent
}: CodeEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const saved = useRef<Text | null>(null)
  const dirty = useRef(false)
  const callbacks = useRef({ onDirtyChange, onEdit, onComment })
  callbacks.current = { onDirtyChange, onEdit, onComment }
  const comment = (editor: EditorView, at?: number): boolean => {
    const ask = callbacks.current.onComment
    if (ask === undefined) return false
    const { doc, selection } = editor.state
    const picked = selection.main
    // The selection's lines when the `+` is inside them, else the one line it is on.
    const within = at === undefined || (at >= doc.lineAt(picked.from).from && at <= picked.to)
    const first = doc.lineAt(within ? picked.from : (at ?? 0)).number
    const last = doc.lineAt(within ? picked.to : (at ?? 0)).number
    const lines: string[] = []
    for (let number = first; number <= last; number += 1) lines.push(doc.line(number).text)
    ask(first, lines)
    return true
  }

  const report = (state: EditorState): void => {
    const next = saved.current !== null && !state.doc.eq(saved.current)
    if (next === dirty.current) return
    dirty.current = next
    callbacks.current.onDirtyChange(next)
  }

  // Mounted once per pane; the parent remounts on a new path or line ending.
  useEffect(() => {
    if (host.current === null) return
    const language = new Compartment()
    const commentable = callbacks.current.onComment !== undefined
    const commentGutter = gutter({
      class: 'cm-commentGutter',
      lineMarker: () => PLUS,
      initialSpacer: () => PLUS,
      domEventHandlers: { mousedown: (editor, line) => comment(editor, line.from) }
    })
    const state = EditorState.create({
      doc: draftText ?? savedText,
      extensions: [
        EditorState.lineSeparator.of(lineEnding),
        commentable ? commentGutter : [],
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        language.of([]),
        codeTheme,
        commentable ? keymap.of([{ key: 'Mod-Shift-a', run: (editor) => comment(editor) }]) : [],
        keymap.of([...searchKeymap, ...historyKeymap, ...foldKeymap, ...defaultKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          report(update.state)
          callbacks.current.onEdit()
        })
      ]
    })
    saved.current = state.toText(savedText)
    const editor = new EditorView({ state, parent: host.current })
    view.current = editor
    report(state)
    let alive = true
    void loadLanguage(path).then((support) => {
      if (alive && support !== null) editor.dispatch({ effects: language.reconfigure(support) })
    })
    return () => {
      alive = false
      editor.destroy()
      view.current = null
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      text: () => view.current?.state.sliceDoc() ?? '',
      markSaved: (text) => {
        const editor = view.current
        if (editor === null) return
        saved.current = editor.state.toText(text)
        report(editor.state)
      },
      replace: (text) => {
        const editor = view.current
        if (editor === null) return
        const head = Math.min(editor.state.selection.main.head, text.length)
        saved.current = editor.state.toText(text)
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: saved.current },
          selection: { anchor: Math.min(head, saved.current.length) }
        })
      }
    }),
    []
  )

  useEffect(() => {
    if (focused && view.current !== null && !view.current.hasFocus) view.current.focus()
  }, [focused])

  const token = goTo?.token
  useEffect(() => {
    const editor = view.current
    if (editor === null || goTo === undefined) return
    const doc = editor.state.doc
    const line = doc.line(Math.min(Math.max(1, goTo.line), doc.lines))
    const at = line.from + Math.min(Math.max(0, goTo.column - 1), line.length)
    editor.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    onWent?.(goTo.token)
  }, [token])

  return <div className="code" ref={host} />
}
