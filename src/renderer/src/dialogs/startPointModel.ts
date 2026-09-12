// Everything the start-from combobox decides, kept out of React so it can be
// tested without a DOM: which rows a query leaves, how they group, where an
// arrow key lands, and what a given row actually submits.
//
// Two rules shape the whole model. The runtime already ordered its options —
// base ref first, then the current branch, then by kind and recency — so
// nothing here re-sorts; grouping only partitions. And the typed text is always
// a candidate in its own right, because the ref someone wants may be a raw sha,
// or may sit in the tail the runtime dropped when it capped the list.

import type { StartPoint, StartPointList } from '@shared/entities'

export type StartPointGroupId = 'base' | 'local' | 'remote' | 'tag' | 'other'

/** The text being typed, offered as a choice of its own. */
export type TypedRow = { kind: 'typed'; id: string; ref: string }
export type OptionRow = { kind: 'option'; id: string; group: StartPointGroupId; option: StartPoint }
export type PickerRow = TypedRow | OptionRow

export type PickerGroup = { id: StartPointGroupId; label: string; rows: OptionRow[] }

export type PickerModel = {
  /** Null when the box is empty or the text already names a listed ref. */
  typed: TypedRow | null
  groups: PickerGroup[]
  /** Every selectable row, in the order the arrow keys walk them. */
  rows: PickerRow[]
  /** True when the runtime capped its listing, filtered or not. */
  truncated: boolean
  /** Refs the cap dropped, so the notice can name a number. */
  droppedCount: number
}

export const TYPED_ROW_ID = 'startpoint-typed'

const GROUP_ORDER: { id: StartPointGroupId; label: string }[] = [
  { id: 'base', label: 'Base ref' },
  { id: 'local', label: 'Local branches' },
  { id: 'remote', label: 'Remote branches' },
  { id: 'tag', label: 'Tags' },
  { id: 'other', label: 'Commits' }
]

export function startPointOptionId(index: number): string {
  return `startpoint-option-${index}`
}

/** Which section a row belongs under. The base ref outranks its own kind. */
export function groupOf(option: StartPoint): StartPointGroupId {
  if (option.isBase) return 'base'
  if (option.kind === 'localBranch') return 'local'
  if (option.kind === 'remoteBranch') return 'remote'
  if (option.kind === 'tag') return 'tag'
  return 'other'
}

/**
 * Substring on the ref and its full name, prefix on the sha — a sha is only
 * ever known from its front, and a substring match inside one is noise.
 */
export function matchesQuery(option: StartPoint, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  if (option.ref.toLowerCase().includes(needle)) return true
  if (option.refName?.toLowerCase().includes(needle)) return true
  return option.sha.toLowerCase().startsWith(needle)
}

export function buildPickerModel(list: StartPointList, query: string): PickerModel {
  const typedRef = query.trim()

  // Indices come from the unfiltered list so a row keeps its id as the query
  // narrows, which is what stops aria-activedescendant naming a stale node.
  const matched: OptionRow[] = []
  list.options.forEach((option, index) => {
    if (!matchesQuery(option, query)) return
    matched.push({ kind: 'option', id: startPointOptionId(index), group: groupOf(option), option })
  })

  const groups = GROUP_ORDER.map(({ id, label }) => ({
    id,
    label,
    rows: matched.filter((row) => row.group === id)
  })).filter((group) => group.rows.length > 0)

  // Naming a listed ref would only duplicate it; anything else typed stays on
  // offer, matches or no matches.
  const alreadyListed = list.options.some((option) => option.ref === typedRef)
  const typed: TypedRow | null =
    typedRef.length > 0 && !alreadyListed ? { kind: 'typed', id: TYPED_ROW_ID, ref: typedRef } : null

  const rows: PickerRow[] = [...(typed ? [typed] : []), ...groups.flatMap((group) => group.rows)]

  return {
    typed,
    groups,
    rows,
    truncated: list.truncated,
    droppedCount: Math.max(0, list.total - list.options.length)
  }
}

/**
 * Where the highlight sits when the query changes: the best real match, or the
 * typed ref when nothing matched. A listed ref wins because the runtime's first
 * row is the one most people mean.
 */
export function defaultActiveId(model: PickerModel): string | null {
  const firstOption = model.rows.find((row) => row.kind === 'option')
  return firstOption?.id ?? model.rows[0]?.id ?? null
}

/** Arrow-key movement. It wraps, because a list this short has no far end. */
export function moveActiveId(model: PickerModel, activeId: string | null, delta: number): string | null {
  if (model.rows.length === 0) return null
  const index = model.rows.findIndex((row) => row.id === activeId)
  if (index < 0) return delta > 0 ? (model.rows[0]?.id ?? null) : (model.rows[model.rows.length - 1]?.id ?? null)
  const count = model.rows.length
  const next = (((index + delta) % count) + count) % count
  return model.rows[next]?.id ?? null
}

export function edgeActiveId(model: PickerModel, edge: 'first' | 'last'): string | null {
  const row = edge === 'first' ? model.rows[0] : model.rows[model.rows.length - 1]
  return row?.id ?? null
}

/** The row that names this ref, so a re-opened list lands on the choice in the box. */
export function idForRef(model: PickerModel, ref: string): string | null {
  const row = model.rows.find((entry) => entry.kind === 'option' && entry.option.ref === ref)
  return row?.id ?? null
}

export function rowById(model: PickerModel, activeId: string | null): PickerRow | null {
  if (!activeId) return null
  return model.rows.find((row) => row.id === activeId) ?? null
}

/** What a row puts in the input, and pins as the selection. */
export type Choice = { ref: string; option: StartPoint | null }

export function choiceOf(row: PickerRow): Choice {
  return row.kind === 'typed' ? { ref: row.ref, option: null } : { ref: row.option.ref, option: row.option }
}

/**
 * What pressing Enter submits. An open list commits its highlighted row; a
 * closed one — or an empty one — commits the text as typed, so a sha, or a ref
 * the listing never knew about, is never trapped behind a filter.
 */
export function commitStartPoint(input: {
  model: PickerModel
  activeId: string | null
  query: string
  open: boolean
}): Choice | null {
  const { model, activeId, query, open } = input
  if (open) {
    const row = rowById(model, activeId)
    if (row) return choiceOf(row)
  }
  const typedRef = query.trim()
  if (typedRef.length === 0) return null
  const listed = model.rows.find((row) => row.kind === 'option' && row.option.ref === typedRef)
  return listed ? choiceOf(listed) : { ref: typedRef, option: null }
}

/**
 * A runtime error arrives with the whole git command line in front of it, which
 * buries the one clause a person can act on. The hint gets the reason only.
 */
export function startPointErrorText(message: string): string {
  const fatal = /\b(?:fatal|error):.*/.exec(message)
  const text = (fatal?.[0] ?? message.split('\n')[0] ?? message).trim()
  return text.length > 140 ? `${text.slice(0, 139)}…` : text
}

/** The badges a row earns, in the order they read best. */
export function badgesOf(option: StartPoint): string[] {
  const badges: string[] = []
  if (option.isBase) badges.push('base')
  if (option.isCurrent) badges.push('current')
  return badges
}
