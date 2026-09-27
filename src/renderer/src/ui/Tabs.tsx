// Tabs that switch a panel: content-wide, an underline on the current one, a count inline. Arrows move along.

import { useRef } from 'react'

export type TabItem<T extends string> = { id: T; label: string; count?: number }

type TabsProps<T extends string> = {
  label: string
  tabs: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
}

export function Tabs<T extends string>({ label, tabs, value, onChange }: TabsProps<T>): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const at = tabs.findIndex((tab) => tab.id === value)
    const next = tabs[(at + step + tabs.length) % tabs.length]
    if (next === undefined) return
    onChange(next.id)
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }
  return (
    <div className="tablist" role="tablist" aria-label={label} ref={list} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="tablist__tab"
          data-tab={tab.id}
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count === undefined ? null : <span className="tablist__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}
