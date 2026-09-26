// The start-from control: an editable combobox whose text is the value, so a sha or unlisted ref submits
// as typed. Focus stays in the input; the highlight moves through aria-activedescendant.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { StartPoint, StartPointList } from '@shared/entities'
import { useEscapeClaim } from './Modal'
import {
  badgesOf,
  buildPickerModel,
  choiceOf,
  defaultActiveId,
  edgeActiveId,
  idForRef,
  moveActiveId,
  rowById,
  startPointErrorText,
  type PickerRow
} from './startPointModel'
import { EMPTY_START_POINTS, type StartPointsState } from './useStartPoints'

/** The text in the box, plus the listed option it stands for, if any. */
export type StartPointValue = { text: string; option: StartPoint | null }

type StartPointPickerProps = {
  state: StartPointsState
  onReload: () => void
  value: StartPointValue
  onChange: (value: StartPointValue) => void
}

export function StartPointPicker({ state, onReload, value, onChange }: StartPointPickerProps): React.JSX.Element {
  const prefix = useId()
  const inputId = `${prefix}-input`
  const listboxId = `${prefix}-listbox`
  const statusId = `${prefix}-status`

  const list: StartPointList = state.phase === 'ready' ? state.list : EMPTY_START_POINTS
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // Text that only echoes the current choice is not a filter.
  const query = filterFor(value)
  const model = useMemo(() => buildPickerModel(list, query), [list, query])
  const activeRow = rowById(model, activeId)
  const typedRow = model.typed

  useEscapeClaim(() => {
    if (!open) return false
    setOpen(false)
    return true
  })

  // Keeps the highlighted row on screen without taking focus off the input.
  useEffect(() => {
    if (!open || !activeId) return
    popRef.current?.querySelector(`#${CSS.escape(prefix + activeId)}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId, prefix])

  const commit = (row: PickerRow): void => {
    const choice = choiceOf(row)
    onChange({ text: choice.ref, option: choice.option })
    setOpen(false)
  }

  const retype = (text: string): void => {
    // Typing a listed ref's exact name adopts its sha, so the summary is as precise.
    const exact = list.options.find((option) => option.ref === text.trim()) ?? null
    const next = buildPickerModel(list, filterFor({ text, option: exact }))
    onChange({ text, option: exact })
    setActiveId(idForRef(next, text.trim()) ?? defaultActiveId(next))
    setOpen(true)
  }

  /** Opening lands on the row already in the box, not on the top of the list. */
  const activeIdOnOpen = (edge: 'first' | 'last'): string | null =>
    idForRef(model, value.text.trim()) ?? (edge === 'first' ? defaultActiveId(model) : edgeActiveId(model, 'last'))

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const down = event.key === 'ArrowDown'
      if (!open) {
        setOpen(true)
        setActiveId(activeIdOnOpen(down ? 'first' : 'last'))
        return
      }
      setActiveId(moveActiveId(model, activeId, down ? 1 : -1))
      return
    }
    if (event.key === 'Enter' && open && activeRow) {
      // Only the open list's Enter is swallowed; with it closed the form submits.
      event.preventDefault()
      commit(activeRow)
      return
    }
    if (event.key === 'Tab' && open) setOpen(false)
  }

  const summaryOption = (open && activeRow?.kind === 'option' ? activeRow.option : null) ?? value.option
  const summaryRef = (open && activeRow ? choiceOf(activeRow).ref : value.text).trim()
  const browsing = open && activeRow !== null

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        Start from
      </label>

      <div className="combo">
        <div className="picker">
          <input
            id={inputId}
            role="combobox"
            className="field__input picker__input picker__input--ref"
            value={value.text}
            onChange={(event) => retype(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setOpen(false)}
            placeholder="origin/main"
            autoComplete="off"
            spellCheck={false}
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeId ? prefix + activeId : undefined}
            aria-describedby={statusId}
          />
          <button
            type="button"
            className="picker__chevron"
            tabIndex={-1}
            aria-label={open ? 'Hide Refs' : 'Show Refs'}
            // Pointer-down: a click lands after the input's blur has closed the list.
            onMouseDown={(event) => {
              event.preventDefault()
              setOpen((wasOpen) => !wasOpen)
              setActiveId(activeIdOnOpen('first'))
              document.getElementById(inputId)?.focus()
            }}
          >
            <Chevron />
          </button>
        </div>

        <p className="field__hint" id={statusId}>
          <StartPointStatus
            state={state}
            onReload={onReload}
            browsing={browsing}
            summaryRef={summaryRef}
            summaryOption={summaryOption}
          />
        </p>

        {open ? (
          <div className="combo__pop" ref={popRef}>
            <div className="combo__list" role="listbox" id={listboxId} aria-label="Start points">
              {typedRow ? (
                <Row domId={prefix + typedRow.id} active={activeId === typedRow.id} onPick={() => commit(typedRow)}>
                  <span className="combo__ref">{typedRow.ref}</span>
                  <span className="combo__note">use as typed</span>
                </Row>
              ) : null}

              {model.groups.map((group) => (
                <div className="combo__group" role="group" key={group.id} aria-labelledby={`${prefix}-${group.id}`}>
                  <div className="combo__grouphead" id={`${prefix}-${group.id}`}>
                    {group.label}
                  </div>
                  {group.rows.map((row) => (
                    <Row key={row.id} domId={prefix + row.id} active={activeId === row.id} onPick={() => commit(row)}>
                      <span className="combo__ref">{row.option.ref}</span>
                      {badgesOf(row.option).map((badge) => (
                        <span className={`combo__badge combo__badge--${badge}`} key={badge}>
                          {badge}
                        </span>
                      ))}
                      <span className="combo__sha">{row.option.shortSha}</span>
                    </Row>
                  ))}
                </div>
              ))}

              {model.rows.length === 0 ? <p className="combo__empty">No matches</p> : null}
            </div>

            {model.truncated ? (
              <p className="combo__footer">
                First {list.limit} of {list.total} refs · type one in full for the other {model.droppedCount}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The one chevron: every select, and Start from. */
export function Chevron(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  )
}

/** The query the list filters by, which is empty while the text is just the choice. */
function filterFor(value: StartPointValue): string {
  return value.option && value.option.ref === value.text.trim() ? '' : value.text
}

function Row({
  domId,
  active,
  onPick,
  children
}: {
  domId: string
  active: boolean
  onPick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      id={domId}
      role="option"
      aria-selected={active}
      className={`combo__row${active ? ' is-active' : ''}`}
      // Same reason as the toggle: the input's blur must not beat the pick.
      onMouseDown={(event) => {
        event.preventDefault()
        onPick()
      }}
    >
      {children}
    </div>
  )
}

/** The line under the field, which also describes the combobox: loading, failed (box still works), or the start commit. */
function StartPointStatus({
  state,
  onReload,
  browsing,
  summaryRef,
  summaryOption
}: {
  state: StartPointsState
  onReload: () => void
  browsing: boolean
  summaryRef: string
  summaryOption: StartPoint | null
}): React.JSX.Element {
  if (state.phase === 'loading') return <>Reading the repository's refs…</>

  if (state.phase === 'error') {
    return (
      <>
        <span className="combo__warn">Could not list refs — {startPointErrorText(state.message)}</span>{' '}
        <button type="button" className="button button--ghost button--tiny" onClick={onReload}>
          Retry
        </button>
      </>
    )
  }

  // Describes what the field takes; the field is already labelled.
  if (summaryRef.length === 0) return <>Branch, tag or commit</>

  // The box already shows the ref; the ref is repeated only for the row being browsed.
  return (
    <span className="combo__summary">
      {browsing ? `${summaryRef} ` : null}
      {summaryOption ? summaryOption.shortSha : 'resolved on create'}
    </span>
  )
}
