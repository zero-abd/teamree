// The settings page's building blocks: what the filter keeps, a card of rows, one row, and the controls
// every section reuses.

import { createContext, useContext, useEffect, useState } from 'react'
import type { RuntimeSettings } from '@shared/settings'
import { Select } from '../ui/Select'
import { Icon } from '../icons/Icon'
import type { RuntimeSettingsState } from './runtimeSettings'
import { describedOnly, labelMatches, rowMatches, type SettingsRow } from './settingsModel'
import { Switch } from '../ui/Switch'

/** Which rows the filter keeps: all of them under a section (or project) whose own name matched. */
export type Shown = {
  whole: boolean
  query: string
  row: (label: string) => boolean
  /** True when the filter is in one of these values or options, so the control holding them is marked. */
  hit: (words: readonly string[]) => boolean
}

export const ShownContext = createContext<Shown>({ whole: true, query: '', row: () => true, hit: () => false })

export function useShown(): Shown {
  return useContext(ShownContext)
}

export function shownUnder(title: string, query: string, rows: readonly SettingsRow[]): Shown {
  const whole = labelMatches(title, query) || describedOnly(title, query)
  return {
    whole,
    query,
    row: (label) => whole || rows.some((row) => row.label === label && rowMatches(row, query)),
    hit: (words) => query.trim() !== '' && words.some((word) => word !== '' && labelMatches(word, query))
  }
}

/** For a control: the attribute that marks it when the filter matched one of its values. */
export function hitMark(shown: Shown, words: readonly string[]): { 'data-match'?: true } {
  return shown.hit(words) ? { 'data-match': true } : {}
}

/** The text, with the filter's words marked where they occur; a label found by what it is about is marked whole. */
export function Marked({ text }: { text: string }): React.JSX.Element {
  const { query } = useShown()
  const wanted = query.trim().toLowerCase()
  const at = wanted === '' ? -1 : text.toLowerCase().indexOf(wanted)
  if (at < 0) return describedOnly(text, query) ? <mark className="settings-match">{text}</mark> : <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="settings-match">{text.slice(at, at + wanted.length)}</mark>
      {text.slice(at + wanted.length)}
    </>
  )
}

/** This Mac's settings, read once for the page so a change in General reaches the projects' rows. */
export const MachineContext = createContext<RuntimeSettingsState>({
  settings: null,
  problem: null,
  change: () => {},
  save: async () => {}
})

/** Where new worktrees go when a project names no folder. */
export function machineRoot(settings: RuntimeSettings | null): string {
  return settings?.worktreesRoot ?? settings?.worktreesRootFallback ?? ''
}

export function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One card of rows under a heading, with an optional summary or control at the heading's right. */
export function Group({
  title,
  aside,
  className,
  children
}: {
  title?: string
  aside?: React.ReactNode
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-card">
      {title === undefined && aside === undefined ? null : (
        <div className="settings-card__head">
          {title === undefined ? null : <h3 className="settings-card__title">{title}</h3>}
          {aside === undefined ? null : <div className="settings-card__aside">{aside}</div>}
        </div>
      )}
      <div className={className === undefined ? 'settings-group' : `settings-group ${className}`}>{children}</div>
    </div>
  )
}

/**
 * One row: the label (and at most a one-line hint) on the left, the control right-aligned in the control column.
 * `wide` gives the control the rest of the row, for a path or a value with buttons.
 */
export function Field({
  label,
  htmlFor,
  labelId,
  heading = false,
  hint,
  source,
  wide = false,
  below,
  children
}: {
  label: string
  /** The control the label names; a row whose control is a value and buttons has none. */
  htmlFor?: string
  /** For a control named by `aria-labelledby`, such as a group of buttons. */
  labelId?: string
  heading?: boolean
  hint?: string
  /** Where the value comes from, under the label. */
  source?: React.ReactNode
  wide?: boolean
  /** Across the whole row under both, e.g. the command a field builds. */
  below?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const text = <Marked text={label} />
  return (
    <div className={wide ? 'settings-field settings-field--wide' : 'settings-field'}>
      <div className="settings-field__text">
        {htmlFor !== undefined ? (
          <label className="settings-field__label" htmlFor={htmlFor}>
            {text}
          </label>
        ) : heading ? (
          <h4 className="settings-field__label">{text}</h4>
        ) : (
          <span className="settings-field__label" id={labelId}>
            {text}
          </span>
        )}
        {hint === undefined ? null : <span className="settings-field__hint">{hint}</span>}
        {source}
      </div>
      <div className="settings-field__control">{children}</div>
      {below ? <div className="settings-field__below">{below}</div> : null}
    </div>
  )
}

/** A path on one line, cut in the middle so its last two parts stay; the whole path on hover. */
export function PathText({ path, className = '' }: { path: string; className?: string }): React.JSX.Element {
  const parts = path.split('/')
  const tail = parts.length > 3 ? parts.slice(-2).join('/') : path
  const head = path.slice(0, path.length - tail.length)
  return (
    <code className={`settings-path ${className}`.trim()} title={path}>
      {head === '' ? null : (
        <span className="settings-path__head">
          <Marked text={head} />
        </span>
      )}
      <span className="settings-path__tail">
        <Marked text={tail} />
      </span>
    </code>
  )
}

/** A path as a chip: the folder mark, then the path cut in the middle. */
export function PathChip({ path }: { path: string }): React.JSX.Element {
  return (
    <span className="settings-path-chip">
      <Icon name="folder" size={14} className="settings-path-chip__icon" />
      <PathText path={path} />
    </span>
  )
}

/** A label and its switch: the page's one shape for an on/off setting. */
export function CheckField({
  id,
  label,
  hint,
  checked,
  disabled = false,
  onChange
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} />
    </Field>
  )
}

/** A label and a picker over a fixed set of values. */
export function ChoiceField<T extends string>({
  id,
  label,
  value,
  choices,
  onChange,
  children
}: {
  id: string
  label: string
  value: T
  choices: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  /** Beside the picker, e.g. a button that tries the setting. */
  children?: React.ReactNode
}): React.JSX.Element {
  const shown = useShown()
  return (
    <Field label={label} htmlFor={id}>
      {children}
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        {...hitMark(
          shown,
          choices.map((choice) => choice.label)
        )}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** A text field that keeps its value on blur or Enter, and takes the stored spelling back whenever that moves. */
export function useDraft(
  stored: string,
  commit: (value: string) => void
): Pick<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'onBlur' | 'onKeyDown' | 'autoComplete' | 'spellCheck'
> & {
  value: string
} {
  const [draft, setDraft] = useState(stored)
  useEffect(() => {
    setDraft(stored)
  }, [stored])
  // Reset first: a value the store clamps back to what it held changes nothing the effect can see.
  const keep = (): void => {
    const next = draft.trim()
    setDraft(stored)
    if (next !== stored) commit(next)
  }
  return {
    value: draft,
    autoComplete: 'off',
    spellCheck: false,
    onChange: (event) => setDraft(event.target.value),
    onBlur: keep,
    onKeyDown: (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      keep()
    }
  }
}
