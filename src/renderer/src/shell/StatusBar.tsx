// The bottom rail: is the runtime there, what am I looking at, how much of it
// is running. Everything here is a fact, never an action.

import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { collectTerminalIds } from '../panes/paneLayout'
import { formatReadAge, summarizeWorktreeStatus } from '../sidebar/worktreeStatusSummary'
import { RUNTIME_IS_SEEDED } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  ready: 'Runtime ready',
  retrying: 'Reconnecting',
  offline: 'Runtime offline'
}

export function StatusBar({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const connection = useWorkspaceStore((state) => state.connection)
  const runtimeVersion = useWorkspaceStore((state) => state.runtimeVersion)
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === state.activeWorktreeId))
  const layout = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.layouts[state.activeWorktreeId] : undefined
  )
  const status = useWorkspaceStore((state) =>
    state.activeWorktreeId ? state.statuses[state.activeWorktreeId] : undefined
  )
  const totalTerminals = useWorkspaceStore((state) => Object.keys(state.terminals).length)

  const paneCount = collectTerminalIds(layout?.root ?? null).length
  const summary = summarizeWorktreeStatus(status)

  return (
    <footer className="statusbar">
      <span
        className={`statusbar__item statusbar__connection statusbar__connection--${connection.phase}`}
        title={connection.detail ?? CONNECTION_LABEL[connection.phase]}
      >
        <span className="statusbar__dot" aria-hidden="true" />
        {CONNECTION_LABEL[connection.phase] ?? connection.phase}
        {runtimeVersion ? <span className="statusbar__muted">{runtimeVersion}</span> : null}
      </span>

      <span className="statusbar__item">
        {worktree ? (
          <>
            <span className="statusbar__muted">worktree</span>
            {worktree.name}
            <span className="statusbar__branch">{worktree.branch}</span>
          </>
        ) : (
          <span className="statusbar__muted">no worktree open</span>
        )}
      </span>

      {summary && status ? (
        <span className="statusbar__item" title={`read ${formatReadAge(status.readAt, Date.now())}`}>
          <span className="statusbar__muted">git</span>
          {summary.description}
        </span>
      ) : null}

      <span className="statusbar__spacer" />

      {RUNTIME_IS_SEEDED ? <span className="statusbar__badge">seeded data</span> : null}

      <span className="statusbar__item">
        <span className="statusbar__muted">split</span>
        <kbd>{shortcutHint('split-right', modifier)}</kbd>
        <kbd>{shortcutHint('split-down', modifier)}</kbd>
      </span>

      <span className="statusbar__item">
        <span className="statusbar__muted">find</span>
        <kbd>{shortcutHint('find-in-pane', modifier)}</kbd>
      </span>

      {/* The four chords that go somewhere without the mouse, in the order they
          move: down the sidebar, then around the panes of whatever it lands on.
          Here rather than only in the help page because a chord nobody has been
          told is a chord nobody presses, and this rail is where somebody's eye
          already is while they are deciding to reach for the trackpad. */}
      <span className="statusbar__item" title="Previous and next worktree, previous and next pane">
        <span className="statusbar__muted">move</span>
        <kbd>{shortcutHint('previous-worktree', modifier)}</kbd>
        <kbd>{shortcutHint('next-worktree', modifier)}</kbd>
        <kbd>{shortcutHint('focus-previous-pane', modifier)}</kbd>
        <kbd>{shortcutHint('focus-next-pane', modifier)}</kbd>
      </span>

      <span className="statusbar__item" title={`${totalTerminals} terminals across all worktrees`}>
        <span className="statusbar__muted">terminals</span>
        {paneCount}
        <span className="statusbar__muted">/ {totalTerminals}</span>
      </span>
    </footer>
  )
}
