// The icons that pick the right panel's tab and the one that closes it; drawn atop the open panel and
// down the right edge when closed, so the panel stays findable.

import type { RightPanelTab } from './rightPanelState'

/** What the Changes badge counts: what a commit would deal with; ahead/behind belong to the status bar. */
export function changedCount(
  status: { staged: number; unstaged: number; untracked: number; conflicted: number } | undefined
): number {
  if (!status) return 0
  return status.staged + status.unstaged + status.untracked + status.conflicted
}

type RightRailProps = {
  open: boolean
  tab: RightPanelTab
  /** Whatever the status chips count, for the badge on Changes. */
  status: { staged: number; unstaged: number; untracked: number; conflicted: number } | undefined
  /** How many panes the worktree on screen has, for the badge on Panes. */
  panes: number
  onPick: (tab: RightPanelTab) => void
  onToggle: () => void
}

const TABS: readonly { id: RightPanelTab; label: string; icon: React.JSX.Element }[] = [
  {
    id: 'files',
    label: 'Files',
    icon: (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M1.5 3.5 H5.5 L7 5 H12.5 V11.5 H1.5 Z" />
      </svg>
    )
  },
  {
    id: 'changes',
    label: 'Changes',
    icon: (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M4 1.5 H8.5 L11 4 V12.5 H4 Z M5.5 6.5 H9.5 M5.5 9 H9.5" />
      </svg>
    )
  },
  {
    id: 'panes',
    label: 'Panes',
    icon: (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M1.5 2.5 H12.5 V11.5 H1.5 Z M7 2.5 V11.5" />
      </svg>
    )
  }
]

export function RightRail({ open, tab, status, panes, onPick, onToggle }: RightRailProps): React.JSX.Element {
  const counts: Record<RightPanelTab, number> = { files: 0, changes: changedCount(status), panes }
  return (
    <div className={`panel__rail${open ? '' : ' panel__rail--edge'}`}>
      <div
        className="panel__tabs"
        role="tablist"
        aria-label="Right panel"
        aria-orientation={open ? 'horizontal' : 'vertical'}
      >
        {TABS.map((entry) => {
          const current = open && tab === entry.id
          const count = counts[entry.id]
          return (
            <button
              type="button"
              key={entry.id}
              role="tab"
              className={`panel__tab${current ? ' panel__tab--current' : ''}`}
              aria-selected={current}
              aria-label={count > 0 ? `${entry.label}, ${count}` : entry.label}
              title={entry.label}
              onClick={() => onPick(entry.id)}
            >
              {entry.icon}
              {count > 0 ? <span className="panel__badge">{count}</span> : null}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="panel__fold"
        aria-label={open ? 'Hide panel' : 'Show panel'}
        title={open ? 'Hide panel' : 'Show panel'}
        onClick={onToggle}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {open ? <path d="M4 2.5 L7.5 6 L4 9.5" /> : <path d="M8 2.5 L4.5 6 L8 9.5" />}
        </svg>
      </button>
    </div>
  )
}
