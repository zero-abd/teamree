// Nothing here yet: the mark over its split light, a title, an optional hint, and one primary.

import type { ReactNode } from 'react'
import { MarkFull } from '../shell/Brand'

type EmptyStateProps = {
  title: ReactNode
  hint?: ReactNode
  /** One primary, then any secondary verbs. */
  actions?: ReactNode
}

export function EmptyState({ title, hint, actions }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state__inner">
        <div className="empty-state__motif" aria-hidden="true">
          <MarkFull size={56} />
        </div>
        <h2 className="empty-state__title">{title}</h2>
        {hint === undefined ? null : <p className="empty-state__hint">{hint}</p>}
        {actions === undefined ? null : <div className="empty-state__actions">{actions}</div>}
      </div>
    </div>
  )
}
