// The page's glyphs: one per kind of block, and the few its menus need.

import { Icon, type IconName as SetName } from '../icons/Icon'

export type IconName =
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
  | 'grip'
  | 'plus'
  | 'duplicate'
  | 'trash'
  | 'link'
  | 'chevron'

const LETTERS: Partial<Record<IconName, string>> = { text: 'Aa', heading1: 'H1', heading2: 'H2', heading3: 'H3' }

const SET: Partial<Record<IconName, SetName>> = {
  bullets: 'md-bullets',
  numbers: 'md-numbers',
  todo: 'md-todo',
  quote: 'md-quote',
  callout: 'md-callout',
  code: 'md-code',
  table: 'md-table',
  divider: 'md-divider',
  image: 'md-image',
  artifact: 'md-artifact',
  grip: 'md-grip',
  plus: 'plus',
  duplicate: 'md-duplicate',
  trash: 'md-trash',
  link: 'md-link',
  chevron: 'chevron-down'
}

export function BlockIcon({ name, size = 16 }: { name: IconName; size?: 14 | 16 }): React.JSX.Element {
  const letters = LETTERS[name]
  // Drawn by CSS from the attribute, so a row's text is its label alone.
  if (letters !== undefined)
    return <span className="md-glyph md-glyph--letters" data-letters={letters} aria-hidden="true" />
  return <Icon name={SET[name] as SetName} size={size} className="md-glyph" />
}
