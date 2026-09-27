// The button family: primary, secondary, ghost and danger, at three sizes, and the bare icon button.

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from '../icons/Icon'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<ButtonSize, string> = { sm: ' button--small', md: '', lg: ' button--lg' }

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  /** Spins in place of the icon and takes no second press; the width holds. */
  loading?: boolean
  type?: 'button' | 'submit'
  children?: ReactNode
}

/** `button` classes for a variant and size, for an element that cannot be a `Button`. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', loading = false): string {
  return `button button--${variant}${SIZE_CLASS[size]}${loading ? ' button--loading' : ''}`
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = buttonClass(variant, size, loading) + (className === undefined ? '' : ` ${className}`)
  return (
    <button {...rest} type={type} className={classes} aria-busy={loading || undefined}>
      {icon === undefined ? null : <Icon name={icon} />}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> & {
  icon: IconName
  /** Names the button for the tooltip and for anybody listening. */
  label: string
  size?: 'sm' | 'md'
}

/** A bare 24px icon button (26px at `sm`), its label in a tooltip. */
export function IconButton({ icon, label, size = 'md', className, ...rest }: IconButtonProps): React.JSX.Element {
  const classes = `button button--icon${size === 'sm' ? ' button--small' : ''}${
    className === undefined ? '' : ` ${className}`
  }`
  return (
    <Tooltip label={label}>
      <button {...rest} type="button" className={classes} aria-label={label}>
        <Icon name={icon} />
      </button>
    </Tooltip>
  )
}
