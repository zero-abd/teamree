// The new branch's name: the task's own until typed over, and an Auto button to hand it back.

import { useId } from 'react'

export function BranchField({
  edit,
  derived,
  planned,
  problem,
  onEdit
}: {
  /** What the user typed, or null while the name follows the task. */
  edit: string | null
  /** The name the task gives, empty until there is a task. */
  derived: string
  /** Every branch the submit makes; listed when there is more than one. */
  planned: readonly string[]
  problem: string | null
  onEdit: (edit: string | null) => void
}): React.JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const hint = problem ?? (planned.length > 1 ? planned.join(' · ') : null)
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Branch
      </label>
      <div className="branch">
        <input
          id={id}
          className="field__input field__input--mono branch__input"
          value={edit ?? derived}
          placeholder={derived || 'branch-name'}
          // A space is never part of a branch; it becomes the hyphen that was meant.
          onChange={(event) => onEdit(event.target.value.replace(/\s/gu, '-'))}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-describedby={hint === null ? undefined : hintId}
        />
        {edit === null ? (
          <span className="branch__auto">auto</span>
        ) : (
          <button
            type="button"
            className="button button--ghost button--tiny branch__reset"
            onClick={() => onEdit(null)}
          >
            Auto
          </button>
        )}
      </div>
      {hint === null ? null : (
        <p className={`field__hint branch__hint${problem === null ? '' : ' branch__hint--problem'}`} id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}
