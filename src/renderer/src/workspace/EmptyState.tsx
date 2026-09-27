// Nothing here yet: the mark over a split light, one title, and the one move that fills it.

import { MarkFull } from '../shell/Brand'

/** `compact` drops the motif, for a list that came up empty inside a panel. */
export function EmptyState({
  title,
  hint,
  compact = false,
  children
}: {
  title: string
  hint?: React.ReactNode
  compact?: boolean
  /** The actions, the primary first. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}`}>
      {compact ? null : (
        <span className="empty__motif" aria-hidden="true">
          <MarkFull size={56} />
        </span>
      )}
      <p className="empty__title">{title}</p>
      {hint === undefined ? null : <div className="empty__hint">{hint}</div>}
      {children === undefined ? null : <div className="empty__actions">{children}</div>}
    </div>
  )
}
