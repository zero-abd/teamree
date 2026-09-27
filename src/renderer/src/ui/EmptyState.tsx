// Nothing here yet: the mark over its split light, a title, an optional hint, and one primary.

import type { ReactNode } from 'react'

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
          <svg viewBox="0 0 256 256" width={56} height={56} fill="currentColor" focusable="false">
            <path
              fillRule="evenodd"
              d="M16 28H116V228H16Q8 228 8 220V36Q8 28 16 28ZM32 66L96 50V206L32 190ZM140 28H240Q248 28 248 36V220Q248 228 240 228H140ZM160 48L224 68V188L160 208Z"
            />
          </svg>
        </div>
        <h2 className="empty-state__title">{title}</h2>
        {hint === undefined ? null : <p className="empty-state__hint">{hint}</p>}
        {actions === undefined ? null : <div className="empty-state__actions">{actions}</div>}
      </div>
    </div>
  )
}
