// A card holds one coherent object; a section head titles a group of them.

import type { ReactNode } from 'react'

type CardProps = {
  title?: ReactNode
  /** Beside the title, at the header's end. */
  actions?: ReactNode
  /** On the floating ground with the deeper shadow. */
  elevated?: boolean
  className?: string
  children: ReactNode
}

export function Card({ title, actions, elevated = false, className, children }: CardProps): React.JSX.Element {
  const classes = `card${elevated ? ' card--elevated' : ''}${className === undefined ? '' : ` ${className}`}`
  return (
    <section className={classes}>
      {title === undefined && actions === undefined ? null : (
        <header className="card__header">
          <h3 className="card__title">{title}</h3>
          {actions}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  )
}

export function SectionHeader({ title, summary }: { title: ReactNode; summary?: ReactNode }): React.JSX.Element {
  return (
    <div className="section-head">
      <h2 className="section-head__title">{title}</h2>
      {summary === undefined ? null : <span className="section-head__summary">{summary}</span>}
    </div>
  )
}
