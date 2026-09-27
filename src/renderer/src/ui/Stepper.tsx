// A small count: minus, the number, plus.

type StepperProps = {
  /** Names the count, e.g. an agent's name: "Fewer Codex", "More Codex". */
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}

export function Stepper({ label, value, min = 0, max = Infinity, onChange }: StepperProps): React.JSX.Element {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__button"
        aria-label={`Fewer ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="stepper__value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="stepper__button"
        aria-label={`More ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </span>
  )
}
