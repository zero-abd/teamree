// A page's head: an icon tile, the title with a meta line under it, actions at the right, then the close.

import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons/Icon'

type PageHeaderProps = {
  title: string
  icon?: IconName
  /** One line under the title, e.g. "Dark · Violet · SF Mono 13". */
  lede?: ReactNode
  /** Right-aligned beside the close. */
  trailing?: ReactNode
  onClose: () => void
  closeTitle?: string
}

export function PageHeader({
  title,
  icon,
  lede,
  trailing,
  onClose,
  closeTitle = 'Back to the panes'
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className="page__head-row">
      {icon === undefined ? null : (
        <span className="page__tile" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
      )}
      <div className="page__identity">
        <h1 className="page__title">{title}</h1>
        {lede === undefined ? null : <p className="page__lede">{lede}</p>}
      </div>
      {trailing === undefined ? null : <div className="page__trailing">{trailing}</div>}
      <button
        type="button"
        className="page__close"
        data-tip={closeTitle}
        aria-label="Back to the panes"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  )
}
