// The projects list's view controls: the filter field with its chips, and the Compact toggle.

import { useEffect } from 'react'
import { useSidebarView } from '../state/sidebarViewStore'
import { QUICK_FILTERS } from './sidebarFilter'
import { Icon } from '../icons/Icon'

export function SidebarFilter({
  field,
  onLeave,
  onSubmit
}: {
  field: React.RefObject<HTMLInputElement | null>
  /** ↓, or Escape on an empty field: back to the list. */
  onLeave: () => void
  /** Return: open the first row shown. */
  onSubmit: () => void
}): React.JSX.Element {
  const query = useSidebarView((state) => state.query)
  const quick = useSidebarView((state) => state.quick)
  const setQuery = useSidebarView((state) => state.setQuery)
  const toggleQuick = useSidebarView((state) => state.toggleQuick)
  const filterAsked = useSidebarView((state) => state.filterAsked)
  const filterTaken = useSidebarView((state) => state.filterTaken)

  useEffect(() => {
    if (!filterAsked) return
    field.current?.focus()
    field.current?.select()
    filterTaken()
  }, [field, filterAsked, filterTaken])

  return (
    <div className="sidebar__filter">
      <input
        ref={field}
        type="search"
        className="sidebar__filter-field"
        placeholder="Filter"
        aria-label="Filter worktrees"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (query !== '') setQuery('')
            else onLeave()
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            onLeave()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
        }}
      />
      <div className="sidebar__chips" role="group" aria-label="Quick filters">
        {QUICK_FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="chip sidebar__chip"
            aria-pressed={quick.includes(chip.id)}
            onClick={() => toggleQuick(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function CompactToggle(): React.JSX.Element {
  const compact = useSidebarView((state) => state.compact)
  const setCompact = useSidebarView((state) => state.setCompact)
  return (
    <button
      type="button"
      className="button button--ghost button--icon sidebar__compact"
      title="Compact"
      aria-label="Compact"
      aria-pressed={compact}
      onClick={() => setCompact(!compact)}
    >
      <Icon name={compact ? 'density-compact' : 'density-comfortable'} size={14} />
    </button>
  )
}
