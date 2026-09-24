// What `/` offers: every block the page can hold, in groups, narrowed by what is
// typed after it. Two rows take an argument — `/artifact <url>` and `/image <path>`.

import type { Editor, Range } from '@tiptap/core'
import { artifactTitle, isArtifactUrl } from './artifactUrl'

export type SlashItemId =
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullets'
  | 'numbers'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'code'
  | 'table'
  | 'divider'
  | 'image'
  | 'artifact'

export const SLASH_GROUPS = ['Basic blocks', 'Lists', 'Media', 'Advanced'] as const
export type SlashGroup = (typeof SLASH_GROUPS)[number]

export type SlashItem = {
  id: SlashItemId
  label: string
  group: SlashGroup
  keywords: string
  /** For the two rows that take one: what was typed after the name, or what to type. */
  detail?: string
  argument?: string
}

export const SLASH_ITEMS: readonly Omit<SlashItem, 'argument'>[] = [
  { id: 'text', label: 'Text', group: 'Basic blocks', keywords: 'text paragraph plain p' },
  { id: 'heading1', label: 'Heading 1', group: 'Basic blocks', keywords: 'heading h1 title big' },
  { id: 'heading2', label: 'Heading 2', group: 'Basic blocks', keywords: 'heading h2 subtitle' },
  { id: 'heading3', label: 'Heading 3', group: 'Basic blocks', keywords: 'heading h3' },
  { id: 'quote', label: 'Quote', group: 'Basic blocks', keywords: 'quote blockquote' },
  { id: 'callout', label: 'Callout', group: 'Basic blocks', keywords: 'callout note tip warning alert' },
  { id: 'divider', label: 'Divider', group: 'Basic blocks', keywords: 'divider rule hr line separator' },
  { id: 'bullets', label: 'Bulleted list', group: 'Lists', keywords: 'bullet list ul unordered' },
  { id: 'numbers', label: 'Numbered list', group: 'Lists', keywords: 'number list ol ordered' },
  { id: 'todo', label: 'To-do list', group: 'Lists', keywords: 'todo task check box list' },
  { id: 'image', label: 'Image', group: 'Media', keywords: 'image picture photo png', detail: 'path' },
  {
    id: 'artifact',
    label: 'Artifact',
    group: 'Media',
    keywords: 'artifact claude link card',
    detail: 'claude.ai link'
  },
  { id: 'code', label: 'Code', group: 'Advanced', keywords: 'code fence snippet pre' },
  { id: 'table', label: 'Table', group: 'Advanced', keywords: 'table grid rows columns' }
]

/** Whether the letters of `needle` appear in `text` in order. */
function inOrder(needle: string, text: string): boolean {
  let at = 0
  for (const char of text) if (char === needle[at]) at += 1
  return at === needle.length
}

/** The rows for what was typed after the slash, best first. */
export function slashItems(query: string): SlashItem[] {
  const typed = query.trim()
  const [head = '', ...rest] = typed.split(/\s+/)
  const argument = rest.join(' ')
  const word = head.toLowerCase()
  if (word === 'artifact' && argument.length > 0) {
    const item = SLASH_ITEMS.find((entry) => entry.id === 'artifact')
    if (!item) return []
    return isArtifactUrl(argument) ? [{ ...item, detail: artifactTitle(argument), argument }] : []
  }
  if (word === 'image' && argument.length > 0) {
    const item = SLASH_ITEMS.find((entry) => entry.id === 'image')
    return item ? [{ ...item, detail: argument, argument }] : []
  }
  if (typed.length === 0) return [...SLASH_ITEMS]
  const needle = typed.toLowerCase()
  const score = (item: Omit<SlashItem, 'argument'>): number => {
    const label = item.label.toLowerCase()
    if (label.startsWith(needle)) return 3
    if (label.includes(needle)) return 2
    if (item.keywords.split(' ').some((keyword) => keyword.startsWith(needle))) return 1
    return 0
  }
  const found = SLASH_ITEMS.map((item) => ({ item, score: score(item) })).filter((entry) => entry.score > 0)
  if (found.length === 0) {
    const letters = needle.replace(/\s+/g, '')
    return SLASH_ITEMS.filter((item) => inOrder(letters, item.label.toLowerCase().replace(/[\s-]+/g, ''))).map(
      (item) => ({ ...item })
    )
  }
  return found.sort((left, right) => right.score - left.score).map((entry) => ({ ...entry.item }))
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
      chain.wrapIn('callout', { kind: 'note' }).run()
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
      if (item.argument === undefined) chain.insertContent('/image ').run()
      else chain.setImage({ src: item.argument }).run()
      return
    case 'artifact': {
      if (item.argument === undefined) {
        chain.insertContent('/artifact ').run()
        return
      }
      const url = item.argument
      chain.insertContent({ type: 'artifactCard', attrs: { url, title: artifactTitle(url) } }).run()
      return
    }
  }
}
