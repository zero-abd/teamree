// What `/` offers: every block the page can hold, narrowed by what is typed
// after it. Two rows take an argument — `/artifact <url>` and `/image <path>`.

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

export type SlashItem = {
  id: SlashItemId
  label: string
  /** What the row inserts, in a few words. */
  detail: string
  keywords: string
  /** For the two rows that take one: what was typed after the name. */
  argument?: string
}

export const SLASH_ITEMS: readonly Omit<SlashItem, 'argument'>[] = [
  { id: 'text', label: 'Text', detail: 'Plain paragraph', keywords: 'text paragraph plain p' },
  { id: 'heading1', label: 'Heading 1', detail: 'Large section title', keywords: 'heading h1 title big' },
  { id: 'heading2', label: 'Heading 2', detail: 'Section title', keywords: 'heading h2 subtitle' },
  { id: 'heading3', label: 'Heading 3', detail: 'Small section title', keywords: 'heading h3' },
  { id: 'bullets', label: 'Bulleted list', detail: 'Unordered list', keywords: 'bullet list ul unordered' },
  { id: 'numbers', label: 'Numbered list', detail: 'Ordered list', keywords: 'number list ol ordered' },
  { id: 'todo', label: 'To-do list', detail: 'Tasks with checkboxes', keywords: 'todo task check box list' },
  { id: 'quote', label: 'Quote', detail: 'Block quotation', keywords: 'quote blockquote' },
  { id: 'callout', label: 'Callout', detail: 'A note that stands out', keywords: 'callout note tip warning' },
  { id: 'code', label: 'Code', detail: 'Fenced block with a language', keywords: 'code fence snippet pre' },
  { id: 'table', label: 'Table', detail: 'Three columns, two rows', keywords: 'table grid rows columns' },
  { id: 'divider', label: 'Divider', detail: 'Horizontal rule', keywords: 'divider rule hr line separator' },
  { id: 'image', label: 'Image', detail: '/image path/in/worktree.png', keywords: 'image picture photo png' },
  { id: 'artifact', label: 'Artifact', detail: '/artifact https://claude.ai/…', keywords: 'artifact claude link card' }
]

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
  return SLASH_ITEMS.map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({ ...entry.item }))
}
