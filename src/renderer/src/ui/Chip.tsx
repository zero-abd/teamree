// A chip is a fact about a row in neutral ink; a badge is a count or something new, in the accent's wash.

import type { ReactNode } from 'react'

export function Chip({ children, title }: { children: ReactNode; title?: string }): React.JSX.Element {
  return (
    <span className="chip" title={title}>
      {children}
    </span>
  )
}

export function Badge({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="chip badge">{children}</span>
}
