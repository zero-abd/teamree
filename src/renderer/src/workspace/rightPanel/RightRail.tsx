// The three icons that pick what the right panel shows, and the one that puts
// it away.
//
// Drawn twice, and both are this component: across the top of the panel while
// it is open, and down the window's right edge while it is closed. The closed
// form is what keeps the panel findable — a panel that vanished entirely would
// be reachable only by the chord, and the whole reason it has a files tab is
// that somebody looked for one and did not find it.

import type { RightPanelTab } from './rightPanelState'

/**
 * What the badge on Changes counts: everything a commit would have to deal
 * with. Ahead and behind are about the branch rather than the tree, so they
 * are the status bar's business, not this badge's.
 */
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
  /** The chord that toggles the panel, for the hover text. */
  toggleHint: string
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

export function RightRail({
  open,
  tab,
  status,
  panes,
  toggleHint,
  onPick,
  onToggle
}: RightRailProps): React.JSX.Element {
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
        title={`${open ? 'Hide panel' : 'Show panel'} · ${toggleHint}`}
        onClick={onToggle}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {open ? <path d="M4 2.5 L7.5 6 L4 9.5" /> : <path d="M8 2.5 L4.5 6 L8 9.5" />}
        </svg>
      </button>
    </div>
  )
}
