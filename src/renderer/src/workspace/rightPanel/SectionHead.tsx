import { Icon } from '../../icons/Icon'

/** A foldable section's heading: chevron, title and count, with its actions at the end on hover. */
export function SectionHead({
  title,
  count,
  open,
  onToggle,
  hint,
  children
}: {
  title: string
  count?: string
  open: boolean
  onToggle: () => void
  hint?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <h3 className="scm-head" title={hint}>
      <button type="button" className="scm-head__toggle" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="scm-head__title">{title}</span>
        {count === undefined ? null : <span className="panel__count">{count}</span>}
      </button>
      {children === undefined ? null : <span className="scm-head__actions">{children}</span>}
    </h3>
  )
}
