// Content search over this task or every task of its project. Results stream in grouped by task and
// file; ↑/↓ walk the hits, Enter or a click opens the file at the line.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Worktree } from '@shared/entities'
import type { SearchFileGroup } from './searchModel'
import type { SearchLine } from '@shared/search'
import { worktreeDisplay, worktreeLabel } from '../../sidebar/worktreeDisplay'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { directoryOf, fileNameOf } from './sourceControl'
import { fileKey, groupSearchResults, hitWindow, searchRows, stepHit } from './searchModel'
import { searchSignature, useSearchStore, type SearchForm } from './searchStore'
import { Icon } from '../../icons/Icon'

/** How long the field waits after a keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 200

let focusedFor = 0

export function SearchTab({ worktree }: { worktree: Worktree }): React.JSX.Element {
  const query = useSearchStore((state) => state.query)
  const caseSensitive = useSearchStore((state) => state.caseSensitive)
  const wholeWord = useSearchStore((state) => state.wholeWord)
  const regex = useSearchStore((state) => state.regex)
  const scope = useSearchStore((state) => state.scope)
  const include = useSearchStore((state) => state.include)
  const answered = useSearchStore((state) => state.answered)
  const files = useSearchStore((state) => state.files)
  const summary = useSearchStore((state) => state.summary)
  const running = useSearchStore((state) => state.running)
  const failed = useSearchStore((state) => state.failed)
  const setForm = useSearchStore((state) => state.setForm)
  const run = useSearchStore((state) => state.run)

  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const focusToken = useWorkspaceStore((state) => state.searchFocus)
  const openWorktree = useWorkspaceStore((state) => state.openWorktree)
  const openFileAt = useWorkspaceStore((state) => state.openFileAt)

  const field = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const form: SearchForm = { query, caseSensitive, wholeWord, regex, scope, include }
  const target = { worktreeId: worktree.id, projectId: worktree.projectId }
  const signature = searchSignature(form, target)

  useEffect(() => {
    if (useSearchStore.getState().answered === signature) return
    const timer = setTimeout(() => run({ worktreeId: worktree.id, projectId: worktree.projectId }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [signature, run, worktree.id, worktree.projectId])

  useEffect(() => () => useSearchStore.getState().cancel(), [])

  // Only a new ask takes the caret: a remount after opening a hit in another task must leave it in the file.
  useEffect(() => {
    if (focusToken === focusedFor) return
    focusedFor = focusToken
    field.current?.focus()
    field.current?.select()
  }, [focusToken])

  const siblings = useMemo(
    () =>
      worktrees
        .filter((entry) => entry.projectId === worktree.projectId)
        .map((entry) => ({ id: entry.id, name: worktreeLabel(worktreeDisplay(entry)) })),
    [worktrees, worktree.projectId]
  )
  const groups = useMemo(() => groupSearchResults(files, siblings, worktree.id), [files, siblings, worktree.id])
  const rows = useMemo(() => searchRows(groups, scope === 'all', collapsed), [groups, scope, collapsed])

  useEffect(() => {
    if (selected === null) return
    document.getElementById(rowId(selected))?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const open = (file: SearchFileGroup, hit: SearchLine): void => {
    setSelected(`h:${fileKey(file)}\0${hit.line}`)
    void (async () => {
      if (useWorkspaceStore.getState().activeWorktreeId !== file.worktreeId) await openWorktree(file.worktreeId)
      await openFileAt(file.worktreeId, file.path, hit.line, hit.column)
    })()
  }

  const openSelected = (): void => {
    const key = selected ?? stepHit(rows, null, 1)
    const row = rows.find((entry) => entry.key === key)
    if (row?.kind === 'hit') open(row.file, row.hit)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => stepHit(rows, current, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (answered !== signature) run(target)
      else openSelected()
    }
  }

  const fold = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const toggle = (option: 'caseSensitive' | 'wholeWord' | 'regex', label: string, text: string): React.JSX.Element => (
    <button
      type="button"
      className={`search__toggle${form[option] ? ' search__toggle--on' : ''}`}
      aria-pressed={form[option]}
      aria-label={label}
      title={label}
      onClick={() => setForm({ [option]: !form[option] })}
    >
      {text}
    </button>
  )

  const fileCount = groups.reduce((sum, group) => sum + group.files.length, 0)
  const matches = summary?.matches ?? groups.reduce((sum, group) => sum + group.matches, 0)
  const status = statusLine({
    query,
    running,
    error: failed ?? summary?.error ?? null,
    matches,
    files: fileCount,
    truncated: summary?.truncated === true,
    timedOut: summary?.timedOut === true
  })

  return (
    <section className="search" aria-label="Search in files" onKeyDown={onKeyDown}>
      <div className="search__form">
        <div className="search__field">
          <input
            ref={field}
            className="search__input"
            type="text"
            value={query}
            placeholder="Search"
            aria-label="Search in files"
            spellCheck={false}
            onChange={(event) => {
              setSelected(null)
              setForm({ query: event.target.value })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query !== '') {
                event.preventDefault()
                event.stopPropagation()
                setForm({ query: '' })
              }
            }}
          />
          {toggle('caseSensitive', 'Match Case', 'Aa')}
          {toggle('wholeWord', 'Match Whole Word', 'W')}
          {toggle('regex', 'Use Regular Expression', '.*')}
        </div>
        <input
          className="search__input search__include"
          type="text"
          value={include}
          placeholder="src/**, !*.test.ts"
          aria-label="Files to include"
          spellCheck={false}
          onChange={(event) => setForm({ include: event.target.value })}
        />
        <div className="search__scope" role="group" aria-label="Scope">
          {(['task', 'all'] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={`search__segment${scope === value ? ' search__segment--on' : ''}`}
              aria-pressed={scope === value}
              onClick={() => setForm({ scope: value })}
            >
              {value === 'task' ? 'This Task' : 'All Tasks'}
            </button>
          ))}
        </div>
      </div>

      {status === null ? null : (
        <p className="search__status" role="status">
          {status}
        </p>
      )}

      <ul className="search__results" aria-label="Results">
        {rows.map((row) => {
          if (row.kind === 'task') {
            return (
              <li key={row.key} className="search__task">
                <span className="search__taskName" title={row.group.name}>
                  {row.group.name}
                </span>
                <span className="search__count">{row.group.matches}</span>
              </li>
            )
          }
          if (row.kind === 'file') {
            return (
              <li key={row.key}>
                <button
                  type="button"
                  className="search__file"
                  aria-expanded={!row.collapsed}
                  title={row.file.path}
                  onClick={() => fold(fileKey(row.file))}
                >
                  <Icon name="chevron-right" size={14} className={`chevron${row.collapsed ? '' : ' chevron--open'}`} />
                  <span className="search__fileName">{fileNameOf(row.file.path)}</span>
                  <span className="search__dir">{directoryOf(row.file.path)}</span>
                  <span className="search__count">{row.file.lines.length}</span>
                </button>
              </li>
            )
          }
          const current = row.key === selected
          return (
            <li key={row.key}>
              <button
                type="button"
                id={rowId(row.key)}
                className={`search__hit${current ? ' search__hit--current' : ''}`}
                aria-current={current ? 'true' : undefined}
                title={`${row.file.path}:${row.hit.line}`}
                onClick={() => open(row.file, row.hit)}
              >
                <span className="search__line">{row.hit.line}</span>
                <HitText hit={row.hit} />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const HitText = memo(function HitText({ hit }: { hit: SearchLine }): React.JSX.Element {
  return (
    <span className="search__text" title={hit.text.trim()}>
      {hitWindow(hit.text, hit.ranges).map((part, index) =>
        part.match ? (
          <mark key={index} className="search__match">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </span>
  )
})

/** One line under the form: progress, the count, or what went wrong. */
export function statusLine(state: {
  query: string
  running: boolean
  error: string | null
  matches: number
  files: number
  truncated: boolean
  timedOut: boolean
}): string | null {
  if (state.query === '') return null
  if (state.error !== null) return state.error
  if (state.running && state.matches === 0) return 'Searching…'
  if (state.matches === 0) return 'No matches'
  const count = `${state.matches.toLocaleString('en-US')}${state.truncated ? '+' : ''}`
  const noun = state.matches === 1 && !state.truncated ? 'match' : 'matches'
  const where = `${state.files} ${state.files === 1 ? 'file' : 'files'}`
  return `${count} ${noun} in ${where}${state.timedOut ? ' · timed out' : ''}`
}

function rowId(key: string): string {
  return `search-${key.replace(/[^A-Za-z0-9_-]/g, (char) => `_${char.charCodeAt(0).toString(16)}`)}`
}
