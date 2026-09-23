// A CodeMirror 6 editor over one file's text. The pane owns reading and
// writing; this owns the document and says when it differs from what is saved.

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Text } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
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
  /** Bumped to open the find bar. */
  searchToken: number
  onDirtyChange: (dirty: boolean) => void
  /** Every change to the document. */
  onEdit: () => void
}

export function CodeEditor({
  ref,
  path,
  savedText,
  draftText,
  lineEnding,
  focused,
  searchToken,
  onDirtyChange,
  onEdit
}: CodeEditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const saved = useRef<Text | null>(null)
  const dirty = useRef(false)
  const callbacks = useRef({ onDirtyChange, onEdit })
  callbacks.current = { onDirtyChange, onEdit }

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
    const state = EditorState.create({
      doc: draftText ?? savedText,
      extensions: [
        EditorState.lineSeparator.of(lineEnding),
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

  useEffect(() => {
    if (searchToken > 0 && view.current !== null) openSearchPanel(view.current)
  }, [searchToken])

  return <div className="code" ref={host} />
}
