// One of a few, side by side in a sunken well: the choice raised out of it.

export type SegmentedOption<T extends string> = { value: T; label: string; title?: string }

type SegmentedProps<T extends string> = {
  /** Names the group for anybody listening. */
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__item"
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
