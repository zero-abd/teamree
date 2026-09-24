// The rows every block menu shares: the kinds a block can become, and a plain action row.

import { BLOCK_KINDS, type BlockKind } from './blockActions'
import { BlockIcon, type IconName } from './blockIcons'

const ICONS: Record<BlockKind, IconName> = {
  paragraph: 'text',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  bulletList: 'bullets',
  orderedList: 'numbers',
  taskList: 'todo',
  blockquote: 'quote',
  callout: 'callout',
  codeBlock: 'code'
}

export const kindLabel = (kind: BlockKind): string => BLOCK_KINDS.find((entry) => entry.kind === kind)?.label ?? ''

export function MenuRow({
  icon,
  label,
  current = false,
  danger = false,
  onPick
}: {
  icon: IconName
  label: string
  current?: boolean
  danger?: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={`md-popover__row${current ? ' md-popover__row--current' : ''}${
        danger ? ' md-popover__row--danger' : ''
      }`}
      // The menu must not take the page's selection with it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span className="md-popover__icon">
        <BlockIcon name={icon} />
      </span>
      {label}
    </button>
  )
}

export function KindRows({
  current,
  onPick
}: {
  current: BlockKind | null
  onPick: (kind: BlockKind) => void
}): React.JSX.Element {
  return (
    <>
      {BLOCK_KINDS.map(({ kind, label }) => (
        <MenuRow key={kind} icon={ICONS[kind]} label={label} current={kind === current} onPick={() => onPick(kind)} />
      ))}
    </>
  )
}
