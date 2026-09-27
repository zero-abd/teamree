// A row in a list: an icon, a label, meta at the far end. Selected rows take the selected surface.

import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons/Icon'

type ListRowProps = {
  icon?: IconName
  label: ReactNode
  meta?: ReactNode
  selected?: boolean
  /** Marks the row as the page on screen, for a navigation list. */
  current?: boolean
  onClick?: () => void
}

export function ListRow({ icon, label, meta, selected, current = false, onClick }: ListRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="list-row"
      aria-selected={selected}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {icon === undefined ? null : <Icon name={icon} />}
      <span className="list-row__label">{label}</span>
      {meta === undefined ? null : <span className="list-row__meta">{meta}</span>}
    </button>
  )
}
