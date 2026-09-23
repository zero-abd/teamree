// The schema a markdown pane edits, one list read by the editor and by the
// headless parser and serializer, so the file and the screen agree.

import type { AnyExtension } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import StarterKit from '@tiptap/starter-kit'
import { lowlight } from './codeLanguages'
import { ArtifactCard, CodeBlockWithLanguage, HtmlBlock, HtmlInline, ImageByPath } from './markdownNodes'

export type MarkdownExtensionOptions = {
  onOpenUrl?: (url: string) => void
  /** Where an image path is loaded from; the path itself, headless. */
  resolveImage?: (src: string) => string
}

export function markdownExtensions(options: MarkdownExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Markdown has no underline, so the editor offers none.
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
      codeBlock: false
    }),
    CodeBlockWithLanguage.configure({ lowlight, defaultLanguage: null }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    ImageByPath.configure({ inline: true, allowBase64: false, resolve: options.resolveImage ?? ((src) => src) }),
    HtmlBlock,
    HtmlInline,
    ArtifactCard.configure({ onOpen: options.onOpenUrl ?? (() => {}) })
  ]
}
