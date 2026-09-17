// The strip along the top of the workspace: the panes of the worktree you are
// in, and nothing from any other. What goes in it, in what order and under what
// name is `paneTabs`, which explains why the strip lists panes rather than
// worktrees; this file is the two store actions a tab can reach and the one
// question the store answers that the module cannot see — which pane, if any,
// has the focus.

import { paneTabs, paneTabTitle } from './paneTabs'
import { useWorkspaceStore } from '../state/workspaceStore'

export function TerminalTabs(): React.JSX.Element | null {
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const terminals = useWorkspaceStore((state) => state.terminals)
  // A teammate's pane holding the focus is what takes it off yours, and the
  // strip has to say so by marking nothing: two active tabs, or an active tab
  // beside a focused border somewhere else, would be the second answer this
  // whole arrangement exists to avoid. It is the same test `WorkspaceArea`
  // applies before it hands a focused id to the pane tree.
  const focusedWatchId = useWorkspaceStore((state) => state.focusedWatchId)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const closeTerminal = useWorkspaceStore((state) => state.closeTerminal)

  const tabs = paneTabs(layout?.root ?? null, terminals)
  if (tabs.length === 0) return null

  const focusedTerminalId = focusedWatchId === null ? layout?.focusedTerminalId : null

  return (
    <div className="tabs" role="tablist" aria-label="Terminals in this worktree">
      {tabs.map((tab) => {
        const active = tab.terminalId === focusedTerminalId
        return (
          <div className={`tab${active ? ' tab--active' : ''}`} key={tab.terminalId}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab__main"
              title={paneTabTitle(tab)}
              onClick={() => focusPane(tab.terminalId)}
            >
              {/* The sidebar's dot, borrowed rather than reinvented, exactly as
                  the dashboard borrows it: this is the same reading of the same
                  PTY, and a second dot would be a second vocabulary for four
                  states the app can only honestly describe one way. */}
              <span
                className={tab.activity === null ? 'activity' : `activity activity--${tab.activity}`}
                aria-hidden="true"
              />
              <span className="tab__name">{tab.label}</span>
            </button>
            {/*
              The same close the pane's own bar offers, because there is exactly
              one terminal behind a tab and behind a pane, and closing it kills
              the process. A tab that merely hid a pane while its pty ran on
              would be inventing a state the layout tree has no leaf for, the
              runtime has no record of, and `teamree terminal list` has no word
              for — a pane you could no longer reach and no longer see.
            */}
            <button
              type="button"
              className="tab__close"
              title={`Close pane ${tab.label}`}
              aria-label={`Close pane ${tab.label}`}
              onClick={() => void closeTerminal(tab.terminalId)}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 3 L9 9 M9 3 L3 9" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
