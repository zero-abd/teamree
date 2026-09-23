// The schema a markdown pane edits, one list read by the editor and by the
// headless parser and serializer, so the file and the screen agree.

import type { AnyExtension } from '@tiptap/core'
import { BulletList, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import StarterKit from '@tiptap/starter-kit'
import { lowlight } from './codeLanguages'
import {
  ArtifactCard,
  CodeBlockWithLanguage,
  HtmlBlock,
  HtmlInline,
  ImageByPath,
  type ImageResolver
} from './markdownNodes'

export type MarkdownExtensionOptions = {
  onOpenUrl?: (url: string) => void
  /** Where an image path is loaded from; nowhere when absent. */
  resolveImage?: ImageResolver
}

export function markdownExtensions(options: MarkdownExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Markdown has no underline, so the editor offers none.
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
      codeBlock: false,
      bulletList: false,
      orderedList: false
    }),
    CodeBlockWithLanguage.configure({ lowlight, defaultLanguage: null }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    // After the task list, so `[ ]` typed on a line still wraps in one. GFM lets
    // any list mix task items with plain ones.
    BulletList.extend({ content: '(listItem | taskItem)+' }),
    OrderedList.extend({ content: '(listItem | taskItem)+' }),
    ImageByPath.configure({ inline: true, allowBase64: false, resolve: options.resolveImage ?? (() => null) }),
    HtmlBlock,
    HtmlInline,
    ArtifactCard.configure({ onOpen: options.onOpenUrl ?? (() => {}) })
  ]
}
