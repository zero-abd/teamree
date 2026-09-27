// The app's one select: sans, sized to its longest option, with the pickers' chevron. Settings and dialogs both.

import { Icon } from '../icons/Icon'

export function Select(props: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className'>): React.JSX.Element {
  return (
    <span className="select">
      <select className="select__input" {...props} />
      <span className="select__chevron">
        <Icon name="chevron-down" size={14} />
      </span>
    </span>
  )
}
