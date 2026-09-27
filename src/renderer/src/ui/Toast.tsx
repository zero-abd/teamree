// A notice card: its tone a 2px edge, an icon, a title, one line of detail and small actions.

import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons/Icon'

export type ToastTone = 'neutral' | 'info' | 'asking' | 'success' | 'error'

const ICON: Record<ToastTone, IconName> = {
  neutral: 'bell',
  info: 'bell',
  asking: 'warning',
  success: 'check',
  error: 'warning'
}

type ToastProps = {
  tone?: ToastTone
  title: ReactNode
  detail?: ReactNode
  /** Small buttons under the text. */
  actions?: ReactNode
}

export function Toast({ tone = 'neutral', title, detail, actions }: ToastProps): React.JSX.Element {
  return (
    <div className={`toast toast--${tone}`} role={tone === 'error' || tone === 'asking' ? 'alert' : 'status'}>
      <span className="toast__icon">
        <Icon name={ICON[tone]} />
      </span>
      <div>
        <div className="toast__title">{title}</div>
        {detail === undefined ? null : <div className="toast__text">{detail}</div>}
        {actions === undefined ? null : <div className="toast__actions">{actions}</div>}
      </div>
    </div>
  )
}
