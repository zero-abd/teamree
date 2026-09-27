// An on/off setting's control: a checkbox drawn as a 32 by 18 switch.

type SwitchProps = {
  id?: string
  checked: boolean
  disabled?: boolean
  /** For a switch with no visible label beside it. */
  label?: string
  onChange: (checked: boolean) => void
}

export function Switch({ id, checked, disabled = false, label, onChange }: SwitchProps): React.JSX.Element {
  return (
    <input
      id={id}
      className="switch"
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}
