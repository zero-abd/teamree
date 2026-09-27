// The tabs that pick the right panel's content and the button that folds it: words atop the open
// panel, icons down the right edge when closed, so the panel stays findable.

import type { RightPanelTab } from './rightPanelState'
import { Icon } from '../../icons/Icon'

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
  onPick: (tab: RightPanelTab) => void
  onToggle: () => void
}

const TABS: readonly { id: RightPanelTab; label: string; icon: React.JSX.Element }[] = [
  {
    id: 'files',
    label: 'Files',
    icon: <Icon name="folder" />
  },
  {
    id: 'changes',
    label: 'Changes',
    icon: <Icon name="changes" />
  },
  {
    id: 'search',
    label: 'Search',
    icon: <Icon name="search" />
  }
]

export function RightRail({ open, tab, status, onPick, onToggle }: RightRailProps): React.JSX.Element {
  const counts: Record<RightPanelTab, number> = { files: 0, changes: changedCount(status), search: 0 }
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
              title={open ? undefined : entry.label}
              onClick={() => onPick(entry.id)}
            >
              {open ? <span className="panel__tabLabel">{entry.label}</span> : entry.icon}
              {count > 0 ? <span className="panel__count">{count}</span> : null}
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
        <Icon name={open ? 'panel-hide' : 'panel-show'} size={14} />
      </button>
    </div>
  )
}
