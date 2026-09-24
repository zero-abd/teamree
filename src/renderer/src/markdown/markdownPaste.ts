// Plain text that reads as markdown pastes as the blocks it spells; anything
// the clipboard already carries as rich content pastes the usual way.

import { Extension } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { readMarkdownTree } from './markdownDocument'

const BLOCK_SYNTAX =
  /^(?:#{1,6}[ \t]|[ \t]*[-*+][ \t]|[ \t]*\d{1,9}[.)][ \t]|>|```|~~~|\|.*\||(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/m
const INLINE_SYNTAX = /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)/

/** Whether pasted text has markdown in it worth reading as such. */
function looksLikeMarkdown(text: string): boolean {
  return BLOCK_SYNTAX.test(text) || INLINE_SYNTAX.test(text)
}

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const data = event.clipboardData
            const text = data?.getData('text/plain') ?? ''
            // An editor's own copy carries HTML beside the text; VS Code's is plain text in HTML dress.
            const rich = data?.types.includes('text/html') === true && !data.types.includes('vscode-editor-data')
            if (text.length === 0 || rich || !looksLikeMarkdown(text)) return false
            if (view.state.selection.$from.parent.type.spec.code === true) return false
            const { doc } = readMarkdownTree(text)
            const content = view.state.schema.nodeFromJSON(doc.toJSON()).content
            view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(content)).scrollIntoView())
            return true
          }
        }
      })
    ]
  }
})
